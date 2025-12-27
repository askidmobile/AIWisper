//! VoicePrint matching and storage
//!
//! This module provides speaker recognition by matching speaker embeddings
//! against a database of known voiceprints.

use anyhow::{Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

/// Thresholds for matching (cosine similarity)
pub const THRESHOLD_HIGH: f32 = 0.85;   // High confidence - automatic assignment
pub const THRESHOLD_MEDIUM: f32 = 0.70; // Medium - suggest to user  
pub const THRESHOLD_LOW: f32 = 0.50;    // Low - possible match
pub const THRESHOLD_MIN: f32 = 0.50;    // Minimum for any matching

/// Confidence level for a match
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchConfidence {
    High,
    Medium,
    Low,
    None,
}

impl MatchConfidence {
    /// Get confidence level from similarity score
    pub fn from_similarity(similarity: f32) -> Self {
        if similarity >= THRESHOLD_HIGH {
            Self::High
        } else if similarity >= THRESHOLD_MEDIUM {
            Self::Medium
        } else if similarity >= THRESHOLD_LOW {
            Self::Low
        } else {
            Self::None
        }
    }
}

impl std::fmt::Display for MatchConfidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::High => write!(f, "high"),
            Self::Medium => write!(f, "medium"),
            Self::Low => write!(f, "low"),
            Self::None => write!(f, "none"),
        }
    }
}

/// A saved voiceprint
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePrint {
    pub id: String,
    pub name: String,
    pub embedding: Vec<f32>,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: String,
    pub seen_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Storage file format
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoicePrintStore {
    version: i32,
    voiceprints: Vec<VoicePrint>,
}

impl Default for VoicePrintStore {
    fn default() -> Self {
        Self {
            version: 1,
            voiceprints: Vec::new(),
        }
    }
}

/// Match result
#[derive(Debug, Clone)]
pub struct MatchResult {
    pub voiceprint: VoicePrint,
    pub similarity: f32,
    pub confidence: MatchConfidence,
}

/// VoicePrint storage and matching engine
pub struct VoicePrintMatcher {
    path: PathBuf,
    data: Arc<RwLock<VoicePrintStore>>,
}

impl VoicePrintMatcher {
    /// Create a new VoicePrintMatcher
    ///
    /// # Arguments
    /// * `data_dir` - Base data directory (speakers.json will be created here)
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let path = data_dir.join("speakers.json");
        
        let data = if path.exists() {
            let content = std::fs::read_to_string(&path)
                .context("Failed to read speakers.json")?;
            serde_json::from_str(&content)
                .context("Failed to parse speakers.json")?
        } else {
            VoicePrintStore::default()
        };
        
        tracing::info!(
            "VoicePrintMatcher: loaded {} voiceprints from {:?}",
            data.voiceprints.len(),
            path
        );
        
        Ok(Self {
            path,
            data: Arc::new(RwLock::new(data)),
        })
    }
    
    /// Find the best matching voiceprint for an embedding
    ///
    /// Returns None if no match above THRESHOLD_MIN is found
    pub fn find_best_match(&self, embedding: &[f32]) -> Option<MatchResult> {
        let data = self.data.read();
        
        if data.voiceprints.is_empty() {
            return None;
        }
        
        let mut best_match: Option<MatchResult> = None;
        let mut best_similarity: f32 = 0.0;
        
        for vp in &data.voiceprints {
            let similarity = cosine_similarity(embedding, &vp.embedding);
            
            if similarity > best_similarity && similarity >= THRESHOLD_MIN {
                best_similarity = similarity;
                best_match = Some(MatchResult {
                    voiceprint: vp.clone(),
                    similarity,
                    confidence: MatchConfidence::from_similarity(similarity),
                });
            }
        }
        
        if let Some(ref m) = best_match {
            tracing::info!(
                "[VoicePrint] Match found: {} (similarity={:.2}, confidence={})",
                m.voiceprint.name,
                m.similarity,
                m.confidence
            );
        }
        
        best_match
    }
    
    /// Find all matches above a threshold (sorted by similarity descending)
    pub fn find_all_matches(&self, embedding: &[f32], threshold: f32) -> Vec<MatchResult> {
        let data = self.data.read();
        
        let mut matches: Vec<MatchResult> = data
            .voiceprints
            .iter()
            .filter_map(|vp| {
                let similarity = cosine_similarity(embedding, &vp.embedding);
                if similarity >= threshold {
                    Some(MatchResult {
                        voiceprint: vp.clone(),
                        similarity,
                        confidence: MatchConfidence::from_similarity(similarity),
                    })
                } else {
                    None
                }
            })
            .collect();
        
        // Sort by similarity descending
        matches.sort_by(|a, b| b.similarity.partial_cmp(&a.similarity).unwrap());
        
        matches
    }
    
    /// Match and auto-update embedding if high confidence
    pub fn match_with_auto_update(&self, embedding: &[f32]) -> Option<MatchResult> {
        let result = self.find_best_match(embedding);
        
        if let Some(ref m) = result {
            if m.confidence == MatchConfidence::High {
                if let Err(e) = self.update_embedding(&m.voiceprint.id, embedding) {
                    tracing::error!("[VoicePrint] Failed to update embedding: {}", e);
                }
            }
        }
        
        result
    }
    
    /// Add a new voiceprint
    pub fn add(&self, name: &str, embedding: Vec<f32>, source: Option<String>) -> Result<VoicePrint> {
        let now = chrono::Utc::now().to_rfc3339();
        
        let vp = VoicePrint {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            embedding,
            created_at: now.clone(),
            updated_at: now.clone(),
            last_seen_at: now,
            seen_count: 1,
            sample_path: None,
            source,
            notes: None,
        };
        
        {
            let mut data = self.data.write();
            data.voiceprints.push(vp.clone());
        }
        
        self.save()?;
        
        tracing::info!("[VoicePrint] Added: {} ({})", vp.name, &vp.id[..8]);
        
        Ok(vp)
    }
    
    /// Get all voiceprints
    pub fn get_all(&self) -> Vec<VoicePrint> {
        self.data.read().voiceprints.clone()
    }
    
    /// Get a voiceprint by ID
    pub fn get(&self, id: &str) -> Option<VoicePrint> {
        self.data.read().voiceprints.iter().find(|vp| vp.id == id).cloned()
    }
    
    /// Update voiceprint name
    pub fn update_name(&self, id: &str, name: &str) -> Result<()> {
        {
            let mut data = self.data.write();
            if let Some(vp) = data.voiceprints.iter_mut().find(|vp| vp.id == id) {
                vp.name = name.to_string();
                vp.updated_at = chrono::Utc::now().to_rfc3339();
            } else {
                anyhow::bail!("VoicePrint not found: {}", id);
            }
        }
        
        self.save()?;
        Ok(())
    }
    
    /// Update embedding with weighted average
    pub fn update_embedding(&self, id: &str, new_embedding: &[f32]) -> Result<()> {
        {
            let mut data = self.data.write();
            if let Some(vp) = data.voiceprints.iter_mut().find(|vp| vp.id == id) {
                // Weighted average: new has weight 1, old has weight min(seen_count, 10)
                let old_weight = (vp.seen_count.min(10)) as f32;
                let new_weight = 1.0f32;
                let total_weight = old_weight + new_weight;
                
                for (i, old_val) in vp.embedding.iter_mut().enumerate() {
                    if let Some(&new_val) = new_embedding.get(i) {
                        *old_val = (*old_val * old_weight + new_val * new_weight) / total_weight;
                    }
                }
                
                // Normalize the result
                vp.embedding = normalize_vector(&vp.embedding);
                
                vp.seen_count += 1;
                let now = chrono::Utc::now().to_rfc3339();
                vp.last_seen_at = now.clone();
                vp.updated_at = now;
                
                tracing::info!(
                    "[VoicePrint] Embedding updated: {} (seen_count={})",
                    vp.name,
                    vp.seen_count
                );
            } else {
                anyhow::bail!("VoicePrint not found: {}", id);
            }
        }
        
        self.save()?;
        Ok(())
    }
    
    /// Delete a voiceprint
    pub fn delete(&self, id: &str) -> Result<()> {
        let name = {
            let mut data = self.data.write();
            let idx = data.voiceprints.iter().position(|vp| vp.id == id);
            if let Some(i) = idx {
                let name = data.voiceprints[i].name.clone();
                data.voiceprints.remove(i);
                name
            } else {
                anyhow::bail!("VoicePrint not found: {}", id);
            }
        };
        
        self.save()?;
        tracing::info!("[VoicePrint] Deleted: {} ({})", name, &id[..8]);
        
        Ok(())
    }
    
    /// Count of voiceprints
    pub fn count(&self) -> usize {
        self.data.read().voiceprints.len()
    }
    
    /// Save to disk (atomic write)
    fn save(&self) -> Result<()> {
        let data = self.data.read();
        
        // Create parent directory if needed
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        
        // Atomic write via temp file
        let tmp_path = self.path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&*data)?;
        std::fs::write(&tmp_path, content)?;
        std::fs::rename(&tmp_path, &self.path)?;
        
        Ok(())
    }
}

/// Calculate cosine similarity between two vectors
///
/// Returns a value from -1 to 1, where 1 = identical
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    
    let mut dot_product: f64 = 0.0;
    let mut norm_a: f64 = 0.0;
    let mut norm_b: f64 = 0.0;
    
    for i in 0..a.len() {
        let a_val = a[i] as f64;
        let b_val = b[i] as f64;
        dot_product += a_val * b_val;
        norm_a += a_val * a_val;
        norm_b += b_val * b_val;
    }
    
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    
    (dot_product / (norm_a.sqrt() * norm_b.sqrt())) as f32
}

/// Calculate cosine distance (1 - similarity)
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f64 {
    1.0 - cosine_similarity(a, b) as f64
}

/// Normalize a vector to unit length
fn normalize_vector(v: &[f32]) -> Vec<f32> {
    let sum_sq: f64 = v.iter().map(|&x| (x as f64) * (x as f64)).sum();
    
    if sum_sq < 1e-10 {
        return v.to_vec();
    }
    
    let norm = (1.0 / sum_sq.sqrt()) as f32;
    v.iter().map(|&x| x * norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 0.001);
    }
    
    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 0.001);
    }
    
    #[test]
    fn test_cosine_similarity_opposite() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![-1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim + 1.0).abs() < 0.001);
    }
    
    #[test]
    fn test_normalize_vector() {
        let v = vec![3.0, 4.0];
        let normalized = normalize_vector(&v);
        let length: f32 = normalized.iter().map(|&x| x * x).sum::<f32>().sqrt();
        assert!((length - 1.0).abs() < 0.001);
    }
    
    #[test]
    fn test_confidence_from_similarity() {
        assert_eq!(MatchConfidence::from_similarity(0.90), MatchConfidence::High);
        assert_eq!(MatchConfidence::from_similarity(0.75), MatchConfidence::Medium);
        assert_eq!(MatchConfidence::from_similarity(0.55), MatchConfidence::Low);
        assert_eq!(MatchConfidence::from_similarity(0.40), MatchConfidence::None);
    }
}
