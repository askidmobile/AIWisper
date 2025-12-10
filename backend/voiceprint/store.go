package voiceprint

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Store хранилище голосовых отпечатков
type Store struct {
	path  string
	data  VoicePrintStore
	mu    sync.RWMutex
	dirty bool
}

// NewStore создаёт новое хранилище voiceprints
// dataDir - директория с данными приложения (где лежат сессии)
// speakers.json создаётся рядом с папкой sessions
func NewStore(dataDir string) (*Store, error) {
	// speakers.json хранится в родительской директории относительно sessions
	path := filepath.Join(dataDir, "..", "speakers.json")

	store := &Store{
		path: path,
		data: VoicePrintStore{Version: CurrentVersion},
	}

	// Загружаем существующие данные
	if err := store.load(); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("failed to load speakers: %w", err)
	}

	log.Printf("[VoicePrint] Store initialized: %s (%d voiceprints)", path, len(store.data.VoicePrints))
	return store, nil
}

// load загружает данные из файла
func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}

	if err := json.Unmarshal(data, &s.data); err != nil {
		return fmt.Errorf("failed to parse speakers.json: %w", err)
	}

	// Миграция если нужна
	if s.data.Version < CurrentVersion {
		if err := s.migrate(); err != nil {
			return fmt.Errorf("migration failed: %w", err)
		}
	}

	return nil
}

// migrate выполняет миграцию формата
func (s *Store) migrate() error {
	switch s.data.Version {
	case 0:
		// Миграция с v0 на v1
		s.data.Version = 1
		return s.saveUnsafe()
	default:
		return nil
	}
}

// save сохраняет данные в файл (атомарно)
func (s *Store) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveUnsafe()
}

// saveUnsafe сохраняет без блокировки (вызывать только при удержании lock)
func (s *Store) saveUnsafe() error {
	data, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal speakers: %w", err)
	}

	// Создаём директорию если не существует
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Атомарная запись через временный файл
	tmpPath := s.path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp file: %w", err)
	}

	if err := os.Rename(tmpPath, s.path); err != nil {
		os.Remove(tmpPath) // Cleanup
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	s.dirty = false
	return nil
}

// GetAll возвращает копию всех voiceprints
func (s *Store) GetAll() []VoicePrint {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]VoicePrint, len(s.data.VoicePrints))
	copy(result, s.data.VoicePrints)
	return result
}

// Get возвращает voiceprint по ID
func (s *Store) Get(id string) (*VoicePrint, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == id {
			vp := s.data.VoicePrints[i]
			return &vp, nil
		}
	}

	return nil, fmt.Errorf("voiceprint not found: %s", id)
}

// Add добавляет новый voiceprint
func (s *Store) Add(name string, embedding []float32, source string) (*VoicePrint, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	vp := VoicePrint{
		ID:         uuid.New().String(),
		Name:       name,
		Embedding:  make([]float32, len(embedding)),
		CreatedAt:  now,
		UpdatedAt:  now,
		LastSeenAt: now,
		SeenCount:  1,
		Source:     source,
	}
	copy(vp.Embedding, embedding)

	s.data.VoicePrints = append(s.data.VoicePrints, vp)

	if err := s.saveUnsafe(); err != nil {
		// Откатываем изменения
		s.data.VoicePrints = s.data.VoicePrints[:len(s.data.VoicePrints)-1]
		return nil, err
	}

	log.Printf("[VoicePrint] Added: %s (%s)", vp.Name, vp.ID[:8])
	return &vp, nil
}

// Update обновляет voiceprint
func (s *Store) Update(vp *VoicePrint) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == vp.ID {
			vp.UpdatedAt = time.Now()
			s.data.VoicePrints[i] = *vp
			return s.saveUnsafe()
		}
	}

	return fmt.Errorf("voiceprint not found: %s", vp.ID)
}

// UpdateName обновляет имя voiceprint
func (s *Store) UpdateName(id, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == id {
			s.data.VoicePrints[i].Name = name
			s.data.VoicePrints[i].UpdatedAt = time.Now()
			return s.saveUnsafe()
		}
	}

	return fmt.Errorf("voiceprint not found: %s", id)
}

// UpdateEmbedding обновляет embedding спикера (взвешенное усреднение)
func (s *Store) UpdateEmbedding(id string, newEmbedding []float32) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == id {
			vp := &s.data.VoicePrints[i]

			// Взвешенное усреднение: новый embedding имеет вес 1,
			// старый - вес seenCount (но ограничиваем максимум 10 для предотвращения застывания)
			oldWeight := float32(min(vp.SeenCount, 10))
			newWeight := float32(1)
			totalWeight := oldWeight + newWeight

			for j := range vp.Embedding {
				vp.Embedding[j] = (vp.Embedding[j]*oldWeight + newEmbedding[j]*newWeight) / totalWeight
			}

			// Нормализуем результат
			vp.Embedding = normalizeVector(vp.Embedding)

			vp.SeenCount++
			vp.LastSeenAt = time.Now()
			vp.UpdatedAt = time.Now()

			log.Printf("[VoicePrint] Embedding updated: %s (seenCount=%d)", vp.Name, vp.SeenCount)
			return s.saveUnsafe()
		}
	}

	return fmt.Errorf("voiceprint not found: %s", id)
}

// Delete удаляет voiceprint
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == id {
			name := s.data.VoicePrints[i].Name
			s.data.VoicePrints = append(
				s.data.VoicePrints[:i],
				s.data.VoicePrints[i+1:]...,
			)
			if err := s.saveUnsafe(); err != nil {
				return err
			}
			log.Printf("[VoicePrint] Deleted: %s (%s)", name, id[:8])
			return nil
		}
	}

	return fmt.Errorf("voiceprint not found: %s", id)
}

// Count возвращает количество сохранённых voiceprints
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.data.VoicePrints)
}

// SetSamplePath устанавливает путь к аудио-сэмплу
func (s *Store) SetSamplePath(id, samplePath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.data.VoicePrints {
		if s.data.VoicePrints[i].ID == id {
			s.data.VoicePrints[i].SamplePath = samplePath
			s.data.VoicePrints[i].UpdatedAt = time.Now()
			return s.saveUnsafe()
		}
	}

	return fmt.Errorf("voiceprint not found: %s", id)
}

// GetSamplesDir возвращает директорию для хранения аудио-сэмплов
func (s *Store) GetSamplesDir() string {
	return filepath.Join(filepath.Dir(s.path), "speakers")
}

// normalizeVector нормализует вектор до единичной длины
func normalizeVector(v []float32) []float32 {
	var sumSq float64
	for _, x := range v {
		sumSq += float64(x * x)
	}

	if sumSq < 1e-10 {
		return v
	}

	norm := float32(1.0 / sqrt(sumSq))
	result := make([]float32, len(v))
	for i, x := range v {
		result[i] = x * norm
	}

	return result
}

// sqrt вычисляет квадратный корень
func sqrt(x float64) float64 {
	if x <= 0 {
		return 0
	}
	z := x
	for i := 0; i < 10; i++ {
		z = (z + x/z) / 2
	}
	return z
}
