package ai

import (
	"fmt"
	"math"
)

// Diarizer выполняет кластеризацию спикеров
type Diarizer struct {
	encoder *SpeakerEncoder
}

// NewDiarizer создаёт новый диаризатор
func NewDiarizer(encoder *SpeakerEncoder) *Diarizer {
	return &Diarizer{encoder: encoder}
}

// Diarize обрабатывает сегменты и проставляет SpeakerID
func (d *Diarizer) Diarize(segments []TranscriptSegment, samples []float32) ([]TranscriptSegment, error) {
	if len(segments) == 0 {
		return segments, nil
	}

	// 1. Извлекаем эмбеддинги
	embeddings := make([][]float32, len(segments))
	validIndices := make([]int, 0, len(segments))

	for i, seg := range segments {
		// Convert milliseconds to samples
		startSample := int(seg.Start * 16) // 16 samples per ms (16kHz)
		endSample := int(seg.End * 16)

		// Basic bounds check
		if startSample < 0 {
			startSample = 0
		}
		if endSample > len(samples) {
			endSample = len(samples)
		}

		if startSample >= endSample {
			continue
		}

		segAudio := samples[startSample:endSample]

		// Skip very short segments (< 0.1s) usually silence or noise
		if len(segAudio) < 1600 {
			continue
		}

		emb, err := d.encoder.Encode(segAudio)
		if err != nil {
			// Если сегмент слишком короткий или ошибка - пропускаем
			continue
		}
		embeddings[i] = emb
		validIndices = append(validIndices, i)
	}

	if len(validIndices) < 2 {
		// Если меньше 2 сегментов с голосом, считаем что спикер один
		if len(validIndices) == 1 {
			segments[validIndices[0]].Speaker = "Speaker 0"
		}
		return segments, nil
	}

	// 2. Кластеризация
	// Собираем только валидные эмбеддинги для кластеризации
	validEmbeddings := make([][]float32, len(validIndices))
	for i, idx := range validIndices {
		validEmbeddings[i] = embeddings[idx]
	}

	clusters := clusterEmbeddings(validEmbeddings, 0.65) // Порог сходства (distance threshold)
	// ResNet34 cosine distance обычно: 0.0 - одинаковые, >0.5-0.7 - разные.
	// 0.65 - консервативный порог

	// 3. Обновляем сегменты
	for i, clusterID := range clusters {
		idx := validIndices[i]
		segments[idx].Speaker = fmt.Sprintf("Speaker %d", clusterID)
	}

	return segments, nil
}

// clusterEmbeddings выполняет иерархическую кластеризацию
// Возвращает список ClusterID для каждого входного эмбеддинга
func clusterEmbeddings(embeddings [][]float32, threshold float64) []int {
	n := len(embeddings)
	if n == 0 {
		return nil
	}

	// Инициализируем кластеры: каждый элемент в своём кластере
	// parent[i] указывает на родителя элемента i в системе непересекающихся множеств (Union-Find)
	parent := make([]int, n)
	for i := 0; i < n; i++ {
		parent[i] = i
	}

	// Вычисляем матрицу расстояний и сохраняем пары (i, j, dist)
	type pair struct {
		i, j int
		dist float64
	}
	var pairs []pair

	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			dist := cosineDistance(embeddings[i], embeddings[j])
			if dist < threshold {
				pairs = append(pairs, pair{i, j, dist})
			}
		}
	}

	// Сортируем пары по расстоянию (можно пропустить для простого threshold clustering,
	// но для Single Linkage лучше сортировать. Здесь мы делаем простое объединение по порогу)
	// Если просто объединять все что < threshold, это эквивалентно построению графа и поиску компонент связности.
	// Это transitive closure: A~B и B~C => A~C. Это самый простой метод.

	// Union-Find
	var find func(i int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}

	union := func(i, j int) {
		rootI := find(i)
		rootJ := find(j)
		if rootI != rootJ {
			parent[rootI] = rootJ
		}
	}

	for _, p := range pairs {
		union(p.i, p.j)
	}

	// Нормализуем ID кластеров (0, 1, 2...)
	clusterMap := make(map[int]int) // root -> normalized ID
	result := make([]int, n)
	nextID := 0

	for i := 0; i < n; i++ {
		root := find(i)
		if _, ok := clusterMap[root]; !ok {
			clusterMap[root] = nextID
			nextID++
		}
		result[i] = clusterMap[root]
	}

	return result
}

// cosineDistance возвращает косинусное расстояние (1 - cosine_similarity)
// Диапазон: [0, 2]. 0 - идентичные векторы, 1 - ортогональные, 2 - противоположные.
func cosineDistance(a, b []float32) float64 {
	var dot, normA, normB float64
	for i := 0; i < len(a); i++ {
		dot += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}

	if normA == 0 || normB == 0 {
		return 1.0 // Максимальное расстояние при ошибке
	}

	similarity := dot / (math.Sqrt(normA) * math.Sqrt(normB))

	// Clamp similarity to [-1, 1]
	if similarity > 1.0 {
		similarity = 1.0
	} else if similarity < -1.0 {
		similarity = -1.0
	}

	return 1.0 - similarity
}
