package voiceprint

import (
	"log"
	"math"
)

// Matcher выполняет поиск совпадений voiceprints
type Matcher struct {
	store *Store
}

// NewMatcher создаёт новый matcher
func NewMatcher(store *Store) *Matcher {
	return &Matcher{store: store}
}

// FindBestMatch ищет лучшее совпадение для embedding
// Возвращает nil если совпадение не найдено (similarity < ThresholdMin)
func (m *Matcher) FindBestMatch(embedding []float32) *MatchResult {
	if m.store == nil {
		return nil
	}

	voiceprints := m.store.GetAll()
	if len(voiceprints) == 0 {
		return nil
	}

	var bestMatch *MatchResult
	bestSimilarity := float32(0)

	for i := range voiceprints {
		vp := &voiceprints[i]
		similarity := CosineSimilarity(embedding, vp.Embedding)

		if similarity > bestSimilarity && similarity >= ThresholdMin {
			bestSimilarity = similarity
			// Копируем чтобы избежать проблем с указателем на элемент slice
			vpCopy := *vp
			bestMatch = &MatchResult{
				VoicePrint: &vpCopy,
				Similarity: similarity,
				Confidence: GetConfidence(similarity),
			}
		}
	}

	if bestMatch != nil {
		log.Printf("[VoicePrint] Match found: %s (similarity=%.2f, confidence=%s)",
			bestMatch.VoicePrint.Name, bestMatch.Similarity, bestMatch.Confidence)
	}

	return bestMatch
}

// FindAllMatches возвращает все совпадения выше порога (отсортированные по similarity)
func (m *Matcher) FindAllMatches(embedding []float32, threshold float32) []MatchResult {
	if m.store == nil {
		return nil
	}

	voiceprints := m.store.GetAll()
	var matches []MatchResult

	for i := range voiceprints {
		vp := &voiceprints[i]
		similarity := CosineSimilarity(embedding, vp.Embedding)

		if similarity >= threshold {
			vpCopy := *vp
			matches = append(matches, MatchResult{
				VoicePrint: &vpCopy,
				Similarity: similarity,
				Confidence: GetConfidence(similarity),
			})
		}
	}

	// Сортируем по убыванию similarity
	for i := 0; i < len(matches)-1; i++ {
		for j := i + 1; j < len(matches); j++ {
			if matches[j].Similarity > matches[i].Similarity {
				matches[i], matches[j] = matches[j], matches[i]
			}
		}
	}

	return matches
}

// CosineSimilarity вычисляет косинусное сходство между двумя векторами
// Возвращает значение от -1 до 1, где 1 = идентичные
func CosineSimilarity(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}

	var dotProduct, normA, normB float64
	for i := range a {
		dotProduct += float64(a[i]) * float64(b[i])
		normA += float64(a[i]) * float64(a[i])
		normB += float64(b[i]) * float64(b[i])
	}

	if normA == 0 || normB == 0 {
		return 0
	}

	return float32(dotProduct / (math.Sqrt(normA) * math.Sqrt(normB)))
}

// CosineDistance = 1 - CosineSimilarity
// Используется в существующем коде pipeline.go
func CosineDistance(a, b []float32) float64 {
	return 1.0 - float64(CosineSimilarity(a, b))
}

// MatchWithAutoUpdate ищет совпадение и автоматически обновляет embedding
// если найден match с высокой уверенностью
func (m *Matcher) MatchWithAutoUpdate(embedding []float32) *MatchResult {
	match := m.FindBestMatch(embedding)

	if match != nil && match.Confidence == "high" {
		// Обновляем embedding в store
		if err := m.store.UpdateEmbedding(match.VoicePrint.ID, embedding); err != nil {
			log.Printf("[VoicePrint] Failed to update embedding: %v", err)
		}
	}

	return match
}

// GetStore возвращает хранилище
func (m *Matcher) GetStore() *Store {
	return m.store
}
