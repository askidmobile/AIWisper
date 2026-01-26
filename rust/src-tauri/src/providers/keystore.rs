//! Secure key storage using system keychain with file fallback
//!
//! Uses `keyring` crate to store API keys in:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (via libsecret)
//!
//! Falls back to encrypted file storage if keyring is not available
//! (e.g., in development mode without code signing).

use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::{aead::Aead, Key, KeyInit, XChaCha20Poly1305, XNonce};
use keyring::Entry;
use rand::rngs::OsRng;
use rand::RngCore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{LLMProviderId, STTProviderId};

/// Service name for keyring entries
const SERVICE_NAME: &str = "aiwisper";

/// File name for fallback storage
const FALLBACK_FILE: &str = "api_keys.json";
/// File name for fallback encryption key
const FALLBACK_KEY_FILE: &str = "api_keys.key";

/// Provider type for key storage
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderType {
    STT,
    LLM,
}

impl std::fmt::Display for ProviderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderType::STT => write!(f, "stt"),
            ProviderType::LLM => write!(f, "llm"),
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct EncryptedFallback {
    version: u8,
    nonce: String,
    ciphertext: String,
}

/// Secure key storage manager
#[derive(Debug, Clone)]
pub struct KeyStore {
    /// In-memory cache of keys
    cache: Arc<RwLock<HashMap<String, String>>>,
    /// Path to fallback file
    fallback_path: PathBuf,
    /// Fallback encryption key
    fallback_key: Option<[u8; 32]>,
    /// Whether keyring is available
    keyring_available: Arc<RwLock<bool>>,
}

impl Default for KeyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStore {
    /// Create a new KeyStore instance
    pub fn new() -> Self {
        let fallback_path = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("aiwisper")
            .join(FALLBACK_FILE);
        let fallback_key_path = fallback_path.with_file_name(FALLBACK_KEY_FILE);
        let fallback_key = Self::load_or_create_fallback_key(&fallback_key_path);

        // Load from fallback file synchronously on startup
        let cache = if fallback_path.exists() {
            Self::load_fallback_cache(&fallback_path, fallback_key.as_ref())
        } else {
            HashMap::new()
        };
        
        Self {
            cache: Arc::new(RwLock::new(cache)),
            fallback_path,
            fallback_key,
            keyring_available: Arc::new(RwLock::new(true)), // Assume available until proven otherwise
        }
    }

    fn load_or_create_fallback_key(path: &Path) -> Option<[u8; 32]> {
        if path.exists() {
            match std::fs::read(path) {
                Ok(bytes) => {
                    if bytes.len() == 32 {
                        let mut key = [0u8; 32];
                        key.copy_from_slice(&bytes);
                        return Some(key);
                    }
                    tracing::warn!("Fallback key has invalid length: {} bytes", bytes.len());
                }
                Err(e) => {
                    tracing::warn!("Failed to read fallback key file: {}", e);
                }
            }
        }

        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);

        if let Err(e) = Self::write_key_file(path, &key) {
            tracing::warn!("Failed to create fallback key file: {}", e);
            return None;
        }

        Some(key)
    }

    fn write_key_file(path: &Path, key: &[u8; 32]) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, key)?;
        Self::set_secure_permissions_sync(path)
    }

    fn load_fallback_cache(
        path: &Path,
        fallback_key: Option<&[u8; 32]>,
    ) -> HashMap<String, String> {
        match std::fs::read_to_string(path) {
            Ok(content) => {
                if let Ok(encrypted) = serde_json::from_str::<EncryptedFallback>(&content) {
                    return match fallback_key {
                        Some(key) => match Self::decrypt_cache(&encrypted, key) {
                            Ok(keys) => {
                                tracing::info!("Loaded {} API keys from encrypted fallback", keys.len());
                                keys
                            }
                            Err(e) => {
                                tracing::warn!("Failed to decrypt fallback keys: {}", e);
                                HashMap::new()
                            }
                        },
                        None => {
                            tracing::warn!("Fallback keys are encrypted but key is unavailable");
                            HashMap::new()
                        }
                    };
                }

                match serde_json::from_str::<HashMap<String, String>>(&content) {
                    Ok(keys) => {
                        tracing::info!("Loaded {} API keys from legacy fallback storage", keys.len());
                        keys
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse fallback keys file: {}", e);
                        HashMap::new()
                    }
                }
            }
            Err(e) => {
                tracing::debug!("No fallback keys file found: {}", e);
                HashMap::new()
            }
        }
    }

    fn encrypt_cache(
        cache: &HashMap<String, String>,
        key: &[u8; 32],
    ) -> Result<EncryptedFallback, String> {
        let payload = serde_json::to_vec(cache)
            .map_err(|e| format!("Failed to serialize fallback cache: {}", e))?;
        let mut nonce_bytes = [0u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);

        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce_bytes), payload.as_ref())
            .map_err(|e| format!("Failed to encrypt fallback cache: {}", e))?;

        Ok(EncryptedFallback {
            version: 1,
            nonce: general_purpose::STANDARD.encode(nonce_bytes),
            ciphertext: general_purpose::STANDARD.encode(ciphertext),
        })
    }

    fn decrypt_cache(
        payload: &EncryptedFallback,
        key: &[u8; 32],
    ) -> Result<HashMap<String, String>, String> {
        let nonce_bytes = general_purpose::STANDARD
            .decode(&payload.nonce)
            .map_err(|e| format!("Failed to decode fallback nonce: {}", e))?;
        if nonce_bytes.len() != 24 {
            return Err(format!(
                "Invalid fallback nonce length: {}",
                nonce_bytes.len()
            ));
        }
        let ciphertext = general_purpose::STANDARD
            .decode(&payload.ciphertext)
            .map_err(|e| format!("Failed to decode fallback ciphertext: {}", e))?;

        let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
        let plaintext = cipher
            .decrypt(XNonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|e| format!("Failed to decrypt fallback cache: {}", e))?;

        serde_json::from_slice(&plaintext)
            .map_err(|e| format!("Failed to parse decrypted fallback cache: {}", e))
    }

    fn set_secure_permissions_sync(path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::Permissions::from_mode(0o600);
            std::fs::set_permissions(path, permissions)?;
        }

        Ok(())
    }

    async fn set_secure_permissions(path: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::Permissions::from_mode(0o600);
            tokio::fs::set_permissions(path, permissions).await?;
        }

        Ok(())
    }
    
    /// Save keys to fallback file
    async fn save_to_fallback(&self) {
        let cache = self.cache.read().await;
        if cache.is_empty() {
            return;
        }
        
        // Ensure directory exists
        if let Some(parent) = self.fallback_path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                tracing::error!("Failed to create fallback directory: {}", e);
                return;
            }
        }
        
        let write_result = match self.fallback_key {
            Some(key) => match Self::encrypt_cache(&*cache, &key) {
                Ok(encrypted) => match serde_json::to_string_pretty(&encrypted) {
                    Ok(content) => tokio::fs::write(&self.fallback_path, content).await.map_err(|e| e.to_string()),
                    Err(e) => Err(format!("Failed to serialize encrypted fallback: {}", e)),
                },
                Err(e) => Err(e),
            },
            None => {
                tracing::warn!("Fallback key unavailable, writing plaintext keys");
                match serde_json::to_string_pretty(&*cache) {
                    Ok(content) => tokio::fs::write(&self.fallback_path, content)
                        .await
                        .map_err(|e| e.to_string()),
                    Err(e) => Err(format!("Failed to serialize keys: {}", e)),
                }
            }
        };

        match write_result {
            Ok(_) => {
                if let Err(e) = Self::set_secure_permissions(&self.fallback_path).await {
                    tracing::warn!("Failed to set fallback file permissions: {}", e);
                }
                tracing::info!("Saved {} API keys to fallback storage", cache.len());
            }
            Err(e) => {
                tracing::error!("Failed to write fallback keys file: {}", e);
            }
        }
    }

    /// Generate the keyring entry name for a provider
    fn entry_name(provider_type: ProviderType, provider_id: &str) -> String {
        format!("{}-{}", provider_type, provider_id)
    }

    /// Get or create a keyring entry
    fn get_entry(provider_type: ProviderType, provider_id: &str) -> Result<Entry, String> {
        let entry_name = Self::entry_name(provider_type, provider_id);
        Entry::new(SERVICE_NAME, &entry_name)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))
    }

    /// Store an API key for an STT provider
    pub async fn store_stt_api_key(
        &self,
        provider_id: STTProviderId,
        api_key: &str,
    ) -> Result<(), String> {
        let provider_str = provider_id.to_string();
        self.store_api_key(ProviderType::STT, &provider_str, api_key)
            .await
    }

    /// Store an API key for an LLM provider
    pub async fn store_llm_api_key(
        &self,
        provider_id: LLMProviderId,
        api_key: &str,
    ) -> Result<(), String> {
        let provider_str = provider_id.to_string();
        self.store_api_key(ProviderType::LLM, &provider_str, api_key)
            .await
    }

    /// Store an API key
    async fn store_api_key(
        &self,
        provider_type: ProviderType,
        provider_id: &str,
        api_key: &str,
    ) -> Result<(), String> {
        let entry_name = Self::entry_name(provider_type, provider_id);
        
        // Try keyring first
        let keyring_available = *self.keyring_available.read().await;
        if keyring_available {
            tracing::info!(
                "Attempting to store API key in keyring: service={}, entry={}",
                SERVICE_NAME,
                entry_name
            );
            
            match Self::get_entry(provider_type, provider_id) {
                Ok(entry) => {
                    match entry.set_password(api_key) {
                        Ok(_) => {
                            tracing::info!("Keyring set_password succeeded for {}", entry_name);
                            // Also store in cache for immediate access
                            let mut cache = self.cache.write().await;
                            cache.insert(entry_name.clone(), api_key.to_string());
                            return Ok(());
                        }
                        Err(e) => {
                            tracing::warn!("Keyring set_password failed for {}: {:?}, falling back to file", entry_name, e);
                            *self.keyring_available.write().await = false;
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to create keyring entry: {}, falling back to file", e);
                    *self.keyring_available.write().await = false;
                }
            }
        }
        
        // Fallback to file storage
        tracing::info!("Storing API key in fallback file for {}", entry_name);
        {
            let mut cache = self.cache.write().await;
            cache.insert(entry_name.clone(), api_key.to_string());
        }
        
        self.save_to_fallback().await;
        
        tracing::info!(
            "Stored API key for {} provider: {} (fallback storage)",
            provider_type,
            provider_id
        );
        Ok(())
    }

    /// Get an API key for an STT provider
    pub async fn get_stt_api_key(&self, provider_id: STTProviderId) -> Option<String> {
        let provider_str = provider_id.to_string();
        self.get_api_key(ProviderType::STT, &provider_str).await
    }

    /// Get an API key for an LLM provider
    pub async fn get_llm_api_key(&self, provider_id: LLMProviderId) -> Option<String> {
        let provider_str = provider_id.to_string();
        self.get_api_key(ProviderType::LLM, &provider_str).await
    }

    /// Get an API key
    async fn get_api_key(&self, provider_type: ProviderType, provider_id: &str) -> Option<String> {
        let entry_name = Self::entry_name(provider_type, provider_id);
        
        // Check in-memory cache first (includes fallback file data)
        {
            let cache = self.cache.read().await;
            if let Some(key) = cache.get(&entry_name) {
                tracing::debug!("Found API key in cache for {} (length: {})", entry_name, key.len());
                return Some(key.clone());
            }
        }
        
        // Try keyring if available
        let keyring_available = *self.keyring_available.read().await;
        if keyring_available {
            tracing::debug!(
                "Attempting to get API key from keyring: service={}, entry={}",
                SERVICE_NAME,
                entry_name
            );
            
            if let Ok(entry) = Self::get_entry(provider_type, provider_id) {
                match entry.get_password() {
                    Ok(password) => {
                        tracing::info!("Successfully retrieved API key from keyring for {} (length: {})", entry_name, password.len());
                        // Update cache
                        let mut cache = self.cache.write().await;
                        cache.insert(entry_name, password.clone());
                        return Some(password);
                    }
                    Err(keyring::Error::NoEntry) => {
                        tracing::debug!("No API key found in keyring for {}", entry_name);
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Failed to get API key from keyring for {}: {:?}",
                            entry_name,
                            e
                        );
                    }
                }
            }
        }
        
        tracing::debug!("No API key found for {}", entry_name);
        None
    }

    /// Delete an API key for an STT provider
    pub async fn delete_stt_api_key(&self, provider_id: STTProviderId) -> Result<(), String> {
        let provider_str = provider_id.to_string();
        self.delete_api_key(ProviderType::STT, &provider_str).await
    }

    /// Delete an API key for an LLM provider
    pub async fn delete_llm_api_key(&self, provider_id: LLMProviderId) -> Result<(), String> {
        let provider_str = provider_id.to_string();
        self.delete_api_key(ProviderType::LLM, &provider_str).await
    }

    /// Delete an API key
    async fn delete_api_key(
        &self,
        provider_type: ProviderType,
        provider_id: &str,
    ) -> Result<(), String> {
        let entry_name = Self::entry_name(provider_type, provider_id);
        
        // Remove from cache
        {
            let mut cache = self.cache.write().await;
            cache.remove(&entry_name);
        }
        
        // Save updated cache to fallback
        self.save_to_fallback().await;
        
        // Try to delete from keyring too
        if let Ok(entry) = Self::get_entry(provider_type, provider_id) {
            let _ = entry.delete_credential(); // Ignore errors
        }
        
        tracing::info!(
            "Deleted API key for {} provider: {}",
            provider_type,
            provider_id
        );
        Ok(())
    }

    /// Check if an STT API key is set (without retrieving it)
    pub async fn has_stt_api_key(&self, provider_id: STTProviderId) -> bool {
        let provider_str = provider_id.to_string();
        self.has_api_key(ProviderType::STT, &provider_str).await
    }

    /// Check if an LLM API key is set (without retrieving it)
    pub async fn has_llm_api_key(&self, provider_id: LLMProviderId) -> bool {
        let provider_str = provider_id.to_string();
        self.has_api_key(ProviderType::LLM, &provider_str).await
    }

    /// Check if an API key is set
    async fn has_api_key(&self, provider_type: ProviderType, provider_id: &str) -> bool {
        self.get_api_key(provider_type, provider_id).await.is_some()
    }

    /// Clear the in-memory cache
    pub async fn clear_cache(&self) {
        let mut cache = self.cache.write().await;
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests require a working keyring implementation
    // They may fail in CI environments without proper keyring setup

    #[tokio::test]
    #[ignore = "Requires keyring access"]
    async fn test_keystore_operations() {
        let keystore = KeyStore::new();

        // Store a key
        keystore
            .store_stt_api_key(STTProviderId::OpenAI, "test-key-12345")
            .await
            .expect("Failed to store key");

        // Check it exists
        assert!(keystore.has_stt_api_key(STTProviderId::OpenAI).await);

        // Retrieve it
        let key = keystore.get_stt_api_key(STTProviderId::OpenAI).await;
        assert_eq!(key, Some("test-key-12345".to_string()));

        // Delete it
        keystore
            .delete_stt_api_key(STTProviderId::OpenAI)
            .await
            .expect("Failed to delete key");

        // Verify deleted
        assert!(!keystore.has_stt_api_key(STTProviderId::OpenAI).await);
    }
}
