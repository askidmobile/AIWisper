package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Manager управляет сессиями записи
type Manager struct {
	sessions map[string]*Session
	activeID string
	dataDir  string
	mu       sync.RWMutex

	// Callbacks
	onChunkReady       func(chunk *Chunk)
	onChunkTranscribed func(chunk *Chunk)
}

// NewManager создаёт новый менеджер сессий
func NewManager(dataDir string) (*Manager, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data dir: %w", err)
	}

	m := &Manager{
		sessions: make(map[string]*Session),
		dataDir:  dataDir,
	}

	// Загружаем существующие сессии
	if err := m.LoadSessions(); err != nil {
		// Не критично, просто логируем
		fmt.Printf("Warning: failed to load sessions: %v\n", err)
	}

	return m, nil
}

// CreateSession создаёт новую сессию записи
func (m *Manager) CreateSession(cfg SessionConfig) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.activeID != "" {
		return nil, fmt.Errorf("session already active: %s", m.activeID)
	}

	id := uuid.New().String()
	sessionDir := filepath.Join(m.dataDir, id)

	if err := os.MkdirAll(filepath.Join(sessionDir, "chunks"), 0755); err != nil {
		return nil, fmt.Errorf("failed to create session dir: %w", err)
	}

	session := &Session{
		ID:        id,
		StartTime: time.Now(),
		Status:    SessionStatusRecording,
		Language:  cfg.Language,
		Model:     cfg.Model,
		DataDir:   sessionDir,
		Chunks:    make([]*Chunk, 0),
	}

	m.sessions[id] = session
	m.activeID = id

	// Сохраняем метаданные
	if err := m.SaveSessionMeta(session); err != nil {
		return nil, err
	}

	return session, nil
}

// StopSession останавливает активную сессию
func (m *Manager) StopSession() (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.activeID == "" {
		return nil, fmt.Errorf("no active session")
	}

	session := m.sessions[m.activeID]
	now := time.Now()
	session.EndTime = &now
	session.Status = SessionStatusCompleted
	session.TotalDuration = now.Sub(session.StartTime)

	m.activeID = ""

	// Сохраняем метаданные
	if err := m.SaveSessionMeta(session); err != nil {
		return nil, err
	}

	return session, nil
}

// GetSession возвращает сессию по ID
func (m *Manager) GetSession(id string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.sessions[id]
	if !ok {
		return nil, fmt.Errorf("session not found: %s", id)
	}
	return session, nil
}

// GetActiveSession возвращает текущую активную сессию
func (m *Manager) GetActiveSession() *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.activeID == "" {
		return nil
	}
	return m.sessions[m.activeID]
}

// IsActive проверяет есть ли активная сессия
func (m *Manager) IsActive() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.activeID != ""
}

// ListSessions возвращает список всех сессий
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}

	// Сортируем по времени начала (новые первые)
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].StartTime.After(sessions[j].StartTime)
	})

	return sessions
}

// DeleteSession удаляет сессию и её файлы
func (m *Manager) DeleteSession(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[id]
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}

	if m.activeID == id {
		return fmt.Errorf("cannot delete active session")
	}

	// Удаляем файлы
	if err := os.RemoveAll(session.DataDir); err != nil {
		return fmt.Errorf("failed to delete session files: %w", err)
	}

	delete(m.sessions, id)
	return nil
}

// AddChunk добавляет чанк к сессии
func (m *Manager) AddChunk(sessionID string, chunk *Chunk) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	session.Chunks = append(session.Chunks, chunk)
	session.mu.Unlock()

	// Сохраняем метаданные чанка
	chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
	data, err := json.MarshalIndent(chunk, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(chunkMetaPath, data, 0644); err != nil {
		return err
	}

	// Callback
	if m.onChunkReady != nil {
		m.onChunkReady(chunk)
	}

	return nil
}

// UpdateChunkTranscription обновляет транскрипцию чанка
func (m *Manager) UpdateChunkTranscription(sessionID, chunkID, text string, err error) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	for _, chunk := range session.Chunks {
		if chunk.ID == chunkID {
			now := time.Now()
			chunk.TranscribedAt = &now
			if err != nil {
				chunk.Status = ChunkStatusFailed
				chunk.Error = err.Error()
			} else {
				chunk.Status = ChunkStatusCompleted
				chunk.Transcription = text
			}

			// Сохраняем метаданные чанка
			chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
			data, _ := json.MarshalIndent(chunk, "", "  ")
			os.WriteFile(chunkMetaPath, data, 0644)

			// Callback
			if m.onChunkTranscribed != nil {
				m.onChunkTranscribed(chunk)
			}

			return nil
		}
	}

	return fmt.Errorf("chunk not found: %s", chunkID)
}

// UpdateChunkStereoTranscription обновляет раздельные транскрипции для mic и system
func (m *Manager) UpdateChunkStereoTranscription(sessionID, chunkID, micText, sysText string, err error) error {
	return m.UpdateChunkStereoWithSegments(sessionID, chunkID, micText, sysText, nil, nil, err)
}

// UpdateChunkStereoWithSegments обновляет раздельные транскрипции с сегментами
func (m *Manager) UpdateChunkStereoWithSegments(sessionID, chunkID, micText, sysText string, micSegments, sysSegments []TranscriptSegment, err error) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	for _, chunk := range session.Chunks {
		if chunk.ID == chunkID {
			now := time.Now()
			chunk.TranscribedAt = &now
			if err != nil {
				chunk.Status = ChunkStatusFailed
				chunk.Error = err.Error()
			} else {
				chunk.Status = ChunkStatusCompleted
				chunk.MicText = micText
				chunk.SysText = sysText
				chunk.MicSegments = micSegments
				chunk.SysSegments = sysSegments

				// Объединяем сегменты в хронологический диалог
				chunk.Dialogue = mergeSegmentsToDialogue(micSegments, sysSegments)

				// Формируем общую транскрипцию из диалога
				chunk.Transcription = formatDialogue(chunk.Dialogue)
			}

			// Сохраняем метаданные чанка
			chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
			data, _ := json.MarshalIndent(chunk, "", "  ")
			os.WriteFile(chunkMetaPath, data, 0644)

			// Callback
			if m.onChunkTranscribed != nil {
				m.onChunkTranscribed(chunk)
			}

			return nil
		}
	}

	return fmt.Errorf("chunk not found: %s", chunkID)
}

// mergeSegmentsToDialogue объединяет сегменты mic и sys в хронологическом порядке
func mergeSegmentsToDialogue(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
	var dialogue []TranscriptSegment

	// Добавляем сегменты микрофона
	for _, seg := range micSegments {
		dialogue = append(dialogue, TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Text:    seg.Text,
			Speaker: "mic",
		})
	}

	// Добавляем сегменты системы
	for _, seg := range sysSegments {
		dialogue = append(dialogue, TranscriptSegment{
			Start:   seg.Start,
			End:     seg.End,
			Text:    seg.Text,
			Speaker: "sys",
		})
	}

	// Сортируем по времени начала
	sort.Slice(dialogue, func(i, j int) bool {
		return dialogue[i].Start < dialogue[j].Start
	})

	return dialogue
}

// formatDialogue форматирует диалог для отображения
func formatDialogue(dialogue []TranscriptSegment) string {
	if len(dialogue) == 0 {
		return ""
	}

	var parts []string
	for _, seg := range dialogue {
		speaker := "Вы"
		if seg.Speaker == "sys" {
			speaker = "Собеседник"
		}
		// Форматируем время в MM:SS
		startSec := seg.Start / 1000
		mins := startSec / 60
		secs := startSec % 60
		timeStr := fmt.Sprintf("%02d:%02d", mins, secs)
		parts = append(parts, fmt.Sprintf("[%s] %s: %s", timeStr, speaker, seg.Text))
	}

	return strings.Join(parts, "\n")
}

// SetOnChunkReady устанавливает callback для готовых чанков
func (m *Manager) SetOnChunkReady(fn func(chunk *Chunk)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onChunkReady = fn
}

// SetOnChunkTranscribed устанавливает callback для распознанных чанков
func (m *Manager) SetOnChunkTranscribed(fn func(chunk *Chunk)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onChunkTranscribed = fn
}

// LoadSessions загружает сессии с диска при старте
func (m *Manager) LoadSessions() error {
	entries, err := os.ReadDir(m.dataDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		metaPath := filepath.Join(m.dataDir, entry.Name(), "meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}

		var session Session
		if err := json.Unmarshal(data, &session); err != nil {
			continue
		}

		// Устанавливаем DataDir (не сохраняется в JSON)
		session.DataDir = filepath.Join(m.dataDir, entry.Name())

		// Загружаем summary если есть
		summaryPath := filepath.Join(m.dataDir, entry.Name(), "summary.txt")
		if summaryData, err := os.ReadFile(summaryPath); err == nil {
			session.Summary = string(summaryData)
		}

		// Загружаем чанки
		chunksDir := filepath.Join(m.dataDir, entry.Name(), "chunks")
		chunkFiles, _ := filepath.Glob(filepath.Join(chunksDir, "*.json"))
		for _, chunkFile := range chunkFiles {
			chunkData, err := os.ReadFile(chunkFile)
			if err != nil {
				continue
			}
			var chunk Chunk
			if err := json.Unmarshal(chunkData, &chunk); err != nil {
				continue
			}
			session.Chunks = append(session.Chunks, &chunk)
		}

		// Сортируем чанки по индексу
		sort.Slice(session.Chunks, func(i, j int) bool {
			return session.Chunks[i].Index < session.Chunks[j].Index
		})

		m.sessions[session.ID] = &session
	}

	return nil
}

// SaveSessionMeta сохраняет метаданные сессии
func (m *Manager) SaveSessionMeta(s *Session) error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	metaPath := filepath.Join(s.DataDir, "meta.json")

	// Создаём копию без чанков для meta.json
	meta := struct {
		ID            string        `json:"id"`
		StartTime     time.Time     `json:"startTime"`
		EndTime       *time.Time    `json:"endTime,omitempty"`
		Status        SessionStatus `json:"status"`
		Language      string        `json:"language"`
		Model         string        `json:"model"`
		TotalDuration int64         `json:"totalDuration"`
		SampleCount   int64         `json:"sampleCount"`
		ChunksCount   int           `json:"chunksCount"`
	}{
		ID:            s.ID,
		StartTime:     s.StartTime,
		EndTime:       s.EndTime,
		Status:        s.Status,
		Language:      s.Language,
		Model:         s.Model,
		TotalDuration: int64(s.TotalDuration / time.Millisecond),
		SampleCount:   s.SampleCount,
		ChunksCount:   len(s.Chunks),
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(metaPath, data, 0644)
}

// GetSessionWAVPath возвращает путь к полному WAV файлу сессии
func (m *Manager) GetSessionWAVPath(sessionID string) (string, error) {
	session, err := m.GetSession(sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(session.DataDir, "full.wav"), nil
}

// GetChunkWAVPath возвращает путь к WAV файлу чанка
func (m *Manager) GetChunkWAVPath(sessionID string, chunkIndex int) (string, error) {
	session, err := m.GetSession(sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.wav", chunkIndex)), nil
}

// SetSessionSummary устанавливает summary для сессии
func (m *Manager) SetSessionSummary(sessionID string, summary string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	session.Summary = summary
	session.mu.Unlock()

	// Сохраняем summary в отдельный файл
	summaryPath := filepath.Join(session.DataDir, "summary.txt")
	if err := os.WriteFile(summaryPath, []byte(summary), 0644); err != nil {
		return fmt.Errorf("failed to save summary: %w", err)
	}

	return nil
}
