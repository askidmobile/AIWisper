package session

import (
	"encoding/json"
	"fmt"
	"log"
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

// CreateImportSession создаёт сессию для импортированного файла (без активации)
func (m *Manager) CreateImportSession(cfg SessionConfig) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	id := uuid.New().String()
	sessionDir := filepath.Join(m.dataDir, id)

	if err := os.MkdirAll(filepath.Join(sessionDir, "chunks"), 0755); err != nil {
		return nil, fmt.Errorf("failed to create session dir: %w", err)
	}

	session := &Session{
		ID:        id,
		StartTime: time.Now(),
		Status:    SessionStatusCompleted, // Импортированная сессия сразу completed
		Language:  cfg.Language,
		Model:     cfg.Model,
		DataDir:   sessionDir,
		Chunks:    make([]*Chunk, 0),
	}

	m.sessions[id] = session

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

	if session.Title == "" {
		session.Title = generateSessionTitle(session.StartTime, session.TotalDuration)
	}

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

// SetSessionTitle устанавливает название сессии
func (m *Manager) SetSessionTitle(id string, title string) error {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session not found: %s", id)
	}

	session.Title = title
	m.mu.Unlock()

	// Сохраняем метаданные (SaveSessionMeta использует свой лок)
	if err := m.SaveSessionMeta(session); err != nil {
		return fmt.Errorf("failed to save session meta: %w", err)
	}

	return nil
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

			// Вычисляем время обработки если есть время начала
			if chunk.ProcessingStartTime != nil {
				chunk.ProcessingTime = now.Sub(*chunk.ProcessingStartTime).Milliseconds()
			}

			if err != nil {
				chunk.Status = ChunkStatusFailed
				chunk.Error = err.Error()
				// Очищаем старые данные при ошибке
				chunk.Transcription = ""
				chunk.MicText = ""
				chunk.SysText = ""
				chunk.MicSegments = nil
				chunk.SysSegments = nil
				chunk.Dialogue = nil
			} else {
				chunk.Status = ChunkStatusCompleted
				chunk.Transcription = text
				chunk.Error = "" // Очищаем ошибку при успехе
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

			// Вычисляем время обработки если есть время начала
			if chunk.ProcessingStartTime != nil {
				chunk.ProcessingTime = now.Sub(*chunk.ProcessingStartTime).Milliseconds()
			}

			if err != nil {
				chunk.Status = ChunkStatusFailed
				chunk.Error = err.Error()
				// Очищаем старые данные при ошибке
				chunk.MicText = ""
				chunk.SysText = ""
				chunk.Transcription = ""
				chunk.MicSegments = nil
				chunk.SysSegments = nil
				chunk.Dialogue = nil
			} else {
				chunk.Status = ChunkStatusCompleted
				chunk.Error = "" // Очищаем ошибку при успехе
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

// UpdateChunkWithDiarizedSegments обновляет чанк с диаризованными сегментами (для mono режима с диаризацией)
func (m *Manager) UpdateChunkWithDiarizedSegments(sessionID, chunkID, text string, segments []TranscriptSegment, err error) error {
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

			// Вычисляем время обработки если есть время начала
			if chunk.ProcessingStartTime != nil {
				chunk.ProcessingTime = now.Sub(*chunk.ProcessingStartTime).Milliseconds()
			}

			if err != nil {
				chunk.Status = ChunkStatusFailed
				chunk.Error = err.Error()
				chunk.Transcription = ""
				chunk.Dialogue = nil
			} else {
				chunk.Status = ChunkStatusCompleted
				chunk.Error = ""
				chunk.Transcription = text
				// Сохраняем сегменты как диалог (уже с метками спикеров)
				chunk.Dialogue = segments
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
// Использует word-level timestamps для более точной хронологии, если доступны
func mergeSegmentsToDialogue(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
	log.Printf("mergeSegmentsToDialogue: mic=%d segments, sys=%d segments", len(micSegments), len(sysSegments))

	// Проверяем есть ли word-level данные
	hasWords := false
	for _, seg := range micSegments {
		if len(seg.Words) > 0 {
			hasWords = true
			break
		}
	}
	if !hasWords {
		for _, seg := range sysSegments {
			if len(seg.Words) > 0 {
				hasWords = true
				break
			}
		}
	}

	// Если есть word-level данные, используем их для более точного диалога
	if hasWords {
		return mergeWordsToDialogue(micSegments, sysSegments)
	}

	// Fallback: используем сегменты, но с группировкой
	// Группируем сегменты каждого канала в фразы (чтобы не было разрывов при наложении)
	const maxPauseMs = 2000 // 2 секунды паузы разрывают фразу

	micPhrases := groupSegmentsToPhrases(micSegments, maxPauseMs, "mic")
	sysPhrases := groupSegmentsToPhrases(sysSegments, maxPauseMs, "sys")

	// Объединяем фразы
	var dialogue []TranscriptSegment
	dialogue = append(dialogue, micPhrases...)
	dialogue = append(dialogue, sysPhrases...)

	// Сортируем по времени начала
	sort.Slice(dialogue, func(i, j int) bool {
		return dialogue[i].Start < dialogue[j].Start
	})

	log.Printf("mergeSegmentsToDialogue: result=%d segments (grouped segment-level)", len(dialogue))
	return dialogue
}

// groupSegmentsToPhrases группирует сегменты одного канала в фразы
func groupSegmentsToPhrases(segments []TranscriptSegment, maxPauseMs int64, defaultSpeaker string) []TranscriptSegment {
	if len(segments) == 0 {
		return nil
	}

	var phrases []TranscriptSegment
	var currentPhrase TranscriptSegment
	var phraseTexts []string

	for i, seg := range segments {
		speaker := seg.Speaker
		if speaker == "" {
			speaker = defaultSpeaker
		}

		if i == 0 {
			currentPhrase = TranscriptSegment{
				Start:   seg.Start,
				End:     seg.End,
				Speaker: speaker,
			}
			phraseTexts = []string{seg.Text}
			continue
		}

		prevSeg := segments[i-1]
		pause := seg.Start - prevSeg.End

		// Если спикер сменился (в рамках одного канала это может быть при диаризации sys канала)
		// или пауза слишком большая -> новая фраза
		speakerChanged := speaker != currentPhrase.Speaker
		longPause := pause > maxPauseMs

		if speakerChanged || longPause {
			// Сохраняем текущую
			currentPhrase.Text = strings.Join(phraseTexts, " ")
			phrases = append(phrases, currentPhrase)

			// Начинаем новую
			currentPhrase = TranscriptSegment{
				Start:   seg.Start,
				End:     seg.End,
				Speaker: speaker,
			}
			phraseTexts = []string{seg.Text}
		} else {
			// Продолжаем
			currentPhrase.End = seg.End
			phraseTexts = append(phraseTexts, seg.Text)
		}
	}

	// Последняя фраза
	if len(phraseTexts) > 0 {
		currentPhrase.Text = strings.Join(phraseTexts, " ")
		phrases = append(phrases, currentPhrase)
	}

	return phrases
}

// mergeWordsToDialogue создаёт диалог на основе segment-level timestamps
// Использует segment-first interleaving: работает на уровне сегментов Whisper,
// сохраняя целостность фраз и обрабатывая перекрытия между сегментами
func mergeWordsToDialogue(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
	// Проверяем есть ли сегменты
	if len(micSegments) == 0 && len(sysSegments) == 0 {
		return nil
	}

	// 1. Корректируем аномальные timestamps (слова > 2 сек)
	micSegments = fixAnomalousTimestamps(micSegments)
	sysSegments = fixAnomalousTimestamps(sysSegments)

	// 2. Используем segment-level алгоритм
	result := mergeSegmentsWithOverlapHandling(micSegments, sysSegments)

	// 3. Постобработка: объединение коротких фраз одного спикера
	result = postProcessDialogue(result)

	log.Printf("mergeWordsToDialogue (v3 segment-level): mic=%d, sys=%d -> %d phrases",
		len(micSegments), len(sysSegments), len(result))

	return result
}

// fixAnomalousTimestamps корректирует аномально длинные слова
// Whisper иногда даёт слову длительность в несколько секунд
func fixAnomalousTimestamps(segments []TranscriptSegment) []TranscriptSegment {
	const maxWordDurationMs int64 = 2000 // Слово не может длиться > 2 сек

	for i := range segments {
		for j := range segments[i].Words {
			word := &segments[i].Words[j]
			duration := word.End - word.Start

			if duration > maxWordDurationMs {
				// Корректируем: слово заканчивается через 500ms после начала
				// или в начале следующего слова
				newEnd := word.Start + 500
				if j+1 < len(segments[i].Words) {
					nextStart := segments[i].Words[j+1].Start
					if nextStart < newEnd {
						newEnd = nextStart
					}
				}
				log.Printf("fixAnomalousTimestamps: word '%s' duration %dms -> %dms",
					word.Text, duration, newEnd-word.Start)
				word.End = newEnd
			}
		}

		// Пересчитываем границы сегмента на основе слов
		if len(segments[i].Words) > 0 {
			segments[i].Start = segments[i].Words[0].Start
			segments[i].End = segments[i].Words[len(segments[i].Words)-1].End
		}
	}

	return segments
}

// taggedSegment - сегмент с меткой источника (mic/sys)
type taggedSegment struct {
	segment TranscriptSegment
	isMic   bool
}

// mergeSegmentsWithOverlapHandling объединяет сегменты с обработкой перекрытий
// Работает на уровне сегментов, а не слов, сохраняя целостность фраз
func mergeSegmentsWithOverlapHandling(micSegments, sysSegments []TranscriptSegment) []TranscriptSegment {
	// 1. Помечаем источник каждого сегмента
	var allSegments []taggedSegment
	for _, seg := range micSegments {
		allSegments = append(allSegments, taggedSegment{segment: seg, isMic: true})
	}
	for _, seg := range sysSegments {
		allSegments = append(allSegments, taggedSegment{segment: seg, isMic: false})
	}

	if len(allSegments) == 0 {
		return nil
	}

	// 2. Сортируем по времени начала сегмента
	sort.Slice(allSegments, func(i, j int) bool {
		if allSegments[i].segment.Start == allSegments[j].segment.Start {
			// При равном времени - mic первым (инициатор)
			return allSegments[i].isMic
		}
		return allSegments[i].segment.Start < allSegments[j].segment.Start
	})

	// 3. Обрабатываем перекрытия и объединяем
	var result []TranscriptSegment

	for i, tagged := range allSegments {
		seg := tagged.segment

		// Устанавливаем спикера
		if tagged.isMic {
			if seg.Speaker == "" || seg.Speaker == "mic" {
				seg.Speaker = "Вы"
			}
		} else {
			if seg.Speaker == "" || seg.Speaker == "sys" {
				seg.Speaker = "Собеседник"
			}
		}

		if i == 0 {
			result = append(result, seg)
			continue
		}

		prev := &result[len(result)-1]
		prevIsMic := isMicSpeaker(prev.Speaker)
		currIsMic := tagged.isMic

		// Проверяем перекрытие
		overlap := prev.End - seg.Start

		if prevIsMic == currIsMic {
			// Тот же спикер - проверяем нужно ли объединить
			gap := seg.Start - prev.End
			if gap < segmentMergeGapMs {
				// Объединяем сегменты одного спикера
				prev.End = seg.End
				prev.Text = prev.Text + " " + seg.Text
				prev.Words = append(prev.Words, seg.Words...)
				continue
			}
		} else {
			// Разные спикеры
			if overlap > 0 && overlap < overlapToleranceMs {
				// Небольшое перекрытие - корректируем границы предыдущего сегмента
				log.Printf("mergeSegmentsWithOverlapHandling: correcting overlap %dms between '%s' and '%s'",
					overlap, prev.Speaker, seg.Speaker)
				if prev.End > seg.Start {
					prev.End = seg.Start
				}
			} else if overlap >= overlapToleranceMs {
				// Большое перекрытие - это реальное перебивание, оставляем как есть
				log.Printf("mergeSegmentsWithOverlapHandling: real interruption %dms: '%s' interrupts '%s'",
					overlap, seg.Speaker, prev.Speaker)
			}
		}

		result = append(result, seg)
	}

	return result
}

// Константы для segment-level алгоритма
const (
	segmentMergeGapMs  int64 = 1000 // Объединять сегменты одного спикера с паузой < 1 сек
	overlapToleranceMs int64 = 500  // Перекрытие < 500ms считаем погрешностью timestamps
)

// isMicSpeaker проверяет является ли спикер микрофоном пользователя
func isMicSpeaker(speaker string) bool {
	return speaker == "mic" || speaker == "Вы"
}

// postProcessDialogue объединяет соседние короткие фразы одного спикера
func postProcessDialogue(phrases []TranscriptSegment) []TranscriptSegment {
	if len(phrases) <= 1 {
		return phrases
	}

	var result []TranscriptSegment

	for i, phrase := range phrases {
		if i == 0 {
			result = append(result, phrase)
			continue
		}

		prev := &result[len(result)-1]

		// Проверяем одинаковый ли спикер (с учётом нормализации)
		prevIsMic := isMicSpeaker(prev.Speaker)
		phraseIsMic := isMicSpeaker(phrase.Speaker)

		// Объединяем соседние фразы одного спикера
		if prevIsMic == phraseIsMic {
			gap := phrase.Start - prev.End
			prevDuration := prev.End - prev.Start
			prevWordCount := len(strings.Fields(prev.Text))

			// Условия объединения:
			// 1. Пауза < 800ms И предыдущая фраза короткая (< 2 сек)
			// 2. ИЛИ пауза < 300ms (очень короткая)
			// 3. ИЛИ предыдущая фраза - одно слово И пауза < 1 сек
			shouldMerge := (gap < 800 && prevDuration < 2000) ||
				(gap < 300) ||
				(gap < 1000 && prevWordCount == 1)

			if shouldMerge {
				prev.End = phrase.End
				prev.Text = prev.Text + " " + phrase.Text
				prev.Words = append(prev.Words, phrase.Words...)
				continue
			}
		}

		result = append(result, phrase)
	}

	return result
}

// interleaveDialogue создаёт естественный диалог с правильным чередованием спикеров
// Обрабатывает перекрытия по времени и разбивает длинные сегменты
func interleaveDialogue(micPhrases, sysPhrases []TranscriptSegment) []TranscriptSegment {
	// Объединяем все фразы
	var allPhrases []TranscriptSegment
	allPhrases = append(allPhrases, micPhrases...)
	allPhrases = append(allPhrases, sysPhrases...)

	if len(allPhrases) == 0 {
		return nil
	}

	// Сортируем по времени начала
	sort.Slice(allPhrases, func(i, j int) bool {
		if allPhrases[i].Start == allPhrases[j].Start {
			// При одинаковом времени начала - mic первым (тот кто задаёт вопрос)
			return allPhrases[i].Speaker == "mic"
		}
		return allPhrases[i].Start < allPhrases[j].Start
	})

	// Обрабатываем перекрытия: если фразы перекрываются, разбиваем их
	result := make([]TranscriptSegment, 0, len(allPhrases))

	for i, phrase := range allPhrases {
		if i == 0 {
			result = append(result, phrase)
			continue
		}

		prev := &result[len(result)-1]

		// Проверяем перекрытие с предыдущей фразой
		// Перекрытие: текущая фраза начинается до конца предыдущей
		if phrase.Start < prev.End && phrase.Speaker != prev.Speaker {
			// Есть перекрытие разных спикеров
			// Вариант: обрезаем предыдущую фразу до начала текущей
			// чтобы создать естественное чередование
			if phrase.Start > prev.Start+minPhraseDurationMs {
				// Обрезаем предыдущую только если остаётся достаточная длина
				prev.End = phrase.Start
				// Обрезаем текст пропорционально (приблизительно)
				if len(prev.Words) > 0 {
					cutWords := make([]TranscriptWord, 0)
					var cutTexts []string
					for _, w := range prev.Words {
						if w.End <= phrase.Start {
							cutWords = append(cutWords, w)
							cutTexts = append(cutTexts, w.Text)
						}
					}
					if len(cutWords) > 0 {
						prev.Words = cutWords
						prev.Text = strings.Join(cutTexts, " ")
					}
				}
			}
		}

		result = append(result, phrase)
	}

	return result
}

// collectWords извлекает все слова из сегментов и проставляет спикера по умолчанию
func collectWords(segments []TranscriptSegment, defaultSpeaker string) []TranscriptWord {
	var words []TranscriptWord
	for _, seg := range segments {
		segSpeaker := seg.Speaker
		if segSpeaker == "" {
			segSpeaker = defaultSpeaker
		}
		for _, w := range seg.Words {
			word := w
			// Если у слова нет спикера, берем из сегмента
			if word.Speaker == "" {
				word.Speaker = segSpeaker
			}
			words = append(words, word)
		}
	}
	return words
}

// Константы для группировки диалога
const (
	defaultMaxPauseMs   = 2000  // Пауза для разделения фраз (2 сек)
	maxPhraseDurationMs = 10000 // Максимальная длина фразы (10 сек)
	minPhraseDurationMs = 1000  // Минимальная длина фразы (1 сек)
	shortPauseMs        = 300   // Короткая пауза для поиска точки разбиения

	// Новые константы для event-based interleaving (v2)
	speakerSwitchToleranceMs = 500  // Толерантность к неточности timestamps при смене спикера
	minPauseBetweenPhrasesMs = 800  // Минимальная пауза для проверки вставки другого спикера
	maxOverlapMs             = 1500 // Максимальное перекрытие для "одновременной речи"
	longPauseMs              = 2500 // Очень большая пауза - точно новая фраза
	shortMergeGapMs          = 500  // Короткий промежуток для объединения фраз
	veryShortGapMs           = 200  // Очень короткий промежуток - всегда объединяем
)

// groupWordsToPhrases группирует поток слов в фразы с учетом пауз, смены спикера
// и максимальной длины фразы для создания естественного диалога
func groupWordsToPhrases(words []TranscriptWord, maxPauseMs int64) []TranscriptSegment {
	if len(words) == 0 {
		return nil
	}

	// Сортируем слова (на всякий случай)
	sort.Slice(words, func(i, j int) bool {
		return words[i].Start < words[j].Start
	})

	var phrases []TranscriptSegment
	var currentPhrase TranscriptSegment
	var currentWords []TranscriptWord
	var phraseTexts []string

	// Вспомогательная функция для завершения текущей фразы
	finishPhrase := func(endTime int64) {
		if len(phraseTexts) > 0 {
			currentPhrase.End = endTime
			currentPhrase.Text = strings.Join(phraseTexts, " ")
			currentPhrase.Words = currentWords
			phrases = append(phrases, currentPhrase)
		}
	}

	// Вспомогательная функция для начала новой фразы
	startNewPhrase := func(word TranscriptWord) {
		currentPhrase = TranscriptSegment{
			Start:   word.Start,
			End:     word.End,
			Speaker: word.Speaker,
		}
		phraseTexts = []string{word.Text}
		currentWords = []TranscriptWord{word}
	}

	for i, word := range words {
		if i == 0 {
			startNewPhrase(word)
			continue
		}

		prevWord := words[i-1]
		pause := word.Start - prevWord.End
		phraseDuration := word.End - currentPhrase.Start

		speakerChanged := word.Speaker != currentPhrase.Speaker
		longPause := pause > maxPauseMs
		phraseTooLong := phraseDuration > maxPhraseDurationMs

		// Условия для разбиения фразы
		shouldSplit := speakerChanged || longPause

		// Если фраза слишком длинная - ищем хорошую точку для разбиения
		if phraseTooLong && !shouldSplit {
			// Проверяем есть ли хоть какая-то пауза для разбиения
			if pause > shortPauseMs {
				shouldSplit = true
			} else {
				// Принудительное разбиение при очень длинной фразе (>15 сек)
				if phraseDuration > maxPhraseDurationMs*3/2 {
					shouldSplit = true
				}
			}
		}

		if shouldSplit {
			// Завершаем фразу
			finishPhrase(prevWord.End)
			// Начинаем новую
			startNewPhrase(word)
		} else {
			// Продолжаем текущую фразу
			currentPhrase.End = word.End
			phraseTexts = append(phraseTexts, word.Text)
			currentWords = append(currentWords, word)
		}
	}

	// Последняя фраза
	if len(phraseTexts) > 0 {
		finishPhrase(currentPhrase.End)
	}

	return phrases
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

		// Используем промежуточную структуру для правильной загрузки TotalDuration
		// В JSON TotalDuration хранится в миллисекундах, а не наносекундах
		var meta struct {
			ID            string        `json:"id"`
			StartTime     time.Time     `json:"startTime"`
			EndTime       *time.Time    `json:"endTime,omitempty"`
			Status        SessionStatus `json:"status"`
			Language      string        `json:"language"`
			Model         string        `json:"model"`
			Title         string        `json:"title,omitempty"`
			TotalDuration int64         `json:"totalDuration"` // миллисекунды!
			SampleCount   int64         `json:"sampleCount"`
		}
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		session := Session{
			ID:            meta.ID,
			StartTime:     meta.StartTime,
			EndTime:       meta.EndTime,
			Status:        meta.Status,
			Language:      meta.Language,
			Model:         meta.Model,
			Title:         meta.Title,
			TotalDuration: time.Duration(meta.TotalDuration) * time.Millisecond, // конвертируем из мс
			SampleCount:   meta.SampleCount,
		}

		// Устанавливаем DataDir (не сохраняется в JSON)
		session.DataDir = filepath.Join(m.dataDir, entry.Name())

		// Автогенерация названия, если отсутствует (для старых записей)
		if session.Title == "" {
			session.Title = generateSessionTitle(session.StartTime, session.TotalDuration)
			if err := m.SaveSessionMeta(&session); err != nil {
				log.Printf("LoadSessions: failed to backfill title for %s: %v", session.ID, err)
			}
		}

		// Загружаем summary если есть
		summaryPath := filepath.Join(m.dataDir, entry.Name(), "summary.txt")
		if summaryData, err := os.ReadFile(summaryPath); err == nil {
			session.Summary = string(summaryData)
		}

		// Загружаем чанки
		chunksDir := filepath.Join(m.dataDir, entry.Name(), "chunks")
		chunkFiles, _ := filepath.Glob(filepath.Join(chunksDir, "*.json"))
		log.Printf("LoadSessions: session %s found %d chunk files in %s", session.ID, len(chunkFiles), chunksDir)
		for _, chunkFile := range chunkFiles {
			chunkData, err := os.ReadFile(chunkFile)
			if err != nil {
				log.Printf("LoadSessions: failed to read chunk file %s: %v", chunkFile, err)
				continue
			}
			var chunk Chunk
			if err := json.Unmarshal(chunkData, &chunk); err != nil {
				log.Printf("LoadSessions: failed to unmarshal chunk %s: %v", chunkFile, err)
				continue
			}
			session.Chunks = append(session.Chunks, &chunk)
		}

		// Сортируем чанки по индексу
		sort.Slice(session.Chunks, func(i, j int) bool {
			return session.Chunks[i].Index < session.Chunks[j].Index
		})

		log.Printf("LoadSessions: session %s loaded with %d chunks", session.ID, len(session.Chunks))
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
		Title         string        `json:"title,omitempty"`
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
		Title:         s.Title,
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

// generateSessionTitle формирует короткое имя записи по времени старта
func generateSessionTitle(start time.Time, duration time.Duration) string {
	datePart := start.Format("02.01")
	timePart := start.Format("15:04")
	minutes := int(duration.Minutes())
	lengthPart := ""
	if minutes > 0 {
		lengthPart = fmt.Sprintf(" · %d мин", minutes)
	}

	return fmt.Sprintf("Запись %s %s%s", datePart, timePart, lengthPart)
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

// UpdateFullTranscription обновляет сессию с полной транскрипцией (стерео режим)
// ВАЖНО: Сохраняет структуру чанков, обновляя каждый чанк отдельно
// micSegments и sysSegments содержат сегменты с глобальными timestamps (относительно начала записи)
func (m *Manager) UpdateFullTranscription(sessionID string, micSegments, sysSegments []TranscriptSegment) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	log.Printf("UpdateFullTranscription: session %s has %d chunks in memory, mic=%d segments, sys=%d segments",
		sessionID, len(session.Chunks), len(micSegments), len(sysSegments))

	// Если чанки не загружены в память, попробуем загрузить их с диска
	if len(session.Chunks) == 0 {
		chunksDir := filepath.Join(session.DataDir, "chunks")
		chunkFiles, _ := filepath.Glob(filepath.Join(chunksDir, "*.json"))
		log.Printf("UpdateFullTranscription: no chunks in memory, found %d chunk files on disk", len(chunkFiles))

		for _, chunkFile := range chunkFiles {
			chunkData, err := os.ReadFile(chunkFile)
			if err != nil {
				log.Printf("UpdateFullTranscription: failed to read chunk file %s: %v", chunkFile, err)
				continue
			}
			var chunk Chunk
			if err := json.Unmarshal(chunkData, &chunk); err != nil {
				log.Printf("UpdateFullTranscription: failed to unmarshal chunk %s: %v", chunkFile, err)
				continue
			}
			session.Chunks = append(session.Chunks, &chunk)
		}

		// Сортируем чанки по индексу
		sort.Slice(session.Chunks, func(i, j int) bool {
			return session.Chunks[i].Index < session.Chunks[j].Index
		})

		log.Printf("UpdateFullTranscription: loaded %d chunks from disk", len(session.Chunks))
	}

	// Логируем границы существующих чанков
	for i, c := range session.Chunks {
		log.Printf("UpdateFullTranscription: existing chunk[%d]: ID=%s, StartMs=%d, EndMs=%d", i, c.ID, c.StartMs, c.EndMs)
	}

	// Если всё ещё нет чанков, создаём один с полной транскрипцией
	if len(session.Chunks) == 0 {
		log.Printf("UpdateFullTranscription: NO CHUNKS FOUND even on disk, creating single chunk")
		// Объединяем сегменты в диалог
		dialogue := mergeSegmentsToDialogue(micSegments, sysSegments)

		// Собираем тексты
		var micTexts, sysTexts []string
		for _, seg := range micSegments {
			micTexts = append(micTexts, seg.Text)
		}
		for _, seg := range sysSegments {
			sysTexts = append(sysTexts, seg.Text)
		}
		micText := strings.Join(micTexts, " ")
		sysText := strings.Join(sysTexts, " ")

		now := time.Now()
		chunk := &Chunk{
			ID:            uuid.New().String(),
			SessionID:     sessionID,
			Index:         0,
			StartMs:       0,
			EndMs:         session.TotalDuration.Milliseconds(),
			Duration:      session.TotalDuration,
			IsStereo:      true,
			Status:        ChunkStatusCompleted,
			CreatedAt:     now,
			TranscribedAt: &now,
			MicText:       micText,
			SysText:       sysText,
			MicSegments:   micSegments,
			SysSegments:   sysSegments,
			Dialogue:      dialogue,
			Transcription: formatDialogue(dialogue),
		}
		session.Chunks = []*Chunk{chunk}

		// Сохраняем метаданные чанка
		chunkMetaPath := filepath.Join(session.DataDir, "chunks", "000.json")
		data, _ := json.MarshalIndent(chunk, "", "  ")
		os.WriteFile(chunkMetaPath, data, 0644)

		log.Printf("UpdateFullTranscription: created single chunk with %d dialogue entries", len(dialogue))
	} else {
		// ВАЖНО: Распределяем сегменты по существующим чанкам, сохраняя их структуру
		for _, chunk := range session.Chunks {
			// Фильтруем сегменты, которые попадают в границы этого чанка
			var chunkMicSegs, chunkSysSegs []TranscriptSegment

			// Проверяем валидность границ чанка
			if chunk.EndMs == 0 && chunk.StartMs == 0 {
				// Для чанков без границ (старые сессии) - все сегменты в первый чанк
				chunkMicSegs = micSegments
				chunkSysSegs = sysSegments
				log.Printf("Chunk %d has no boundaries, assigning all segments", chunk.Index)
			} else {
				for _, seg := range micSegments {
					// Сегмент попадает в чанк если он пересекается с границами чанка
					// (начало сегмента < конец чанка И конец сегмента > начало чанка)
					if seg.Start < chunk.EndMs && seg.End > chunk.StartMs {
						chunkMicSegs = append(chunkMicSegs, seg)
					}
				}

				for _, seg := range sysSegments {
					if seg.Start < chunk.EndMs && seg.End > chunk.StartMs {
						chunkSysSegs = append(chunkSysSegs, seg)
					}
				}
			}

			// Объединяем сегменты в диалог для этого чанка
			dialogue := mergeSegmentsToDialogue(chunkMicSegs, chunkSysSegs)

			// Собираем тексты
			var micTexts, sysTexts []string
			for _, seg := range chunkMicSegs {
				micTexts = append(micTexts, seg.Text)
			}
			for _, seg := range chunkSysSegs {
				sysTexts = append(sysTexts, seg.Text)
			}
			micText := strings.Join(micTexts, " ")
			sysText := strings.Join(sysTexts, " ")

			// Обновляем чанк
			now := time.Now()
			chunk.TranscribedAt = &now
			chunk.Status = ChunkStatusCompleted
			chunk.Error = ""
			chunk.MicText = micText
			chunk.SysText = sysText
			chunk.MicSegments = chunkMicSegs
			chunk.SysSegments = chunkSysSegs
			chunk.Dialogue = dialogue
			chunk.Transcription = formatDialogue(dialogue)

			// Сохраняем метаданные чанка
			chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
			data, _ := json.MarshalIndent(chunk, "", "  ")
			os.WriteFile(chunkMetaPath, data, 0644)

			log.Printf("UpdateFullTranscription: chunk %d (%d-%d ms) updated with mic=%d, sys=%d, dialogue=%d",
				chunk.Index, chunk.StartMs, chunk.EndMs, len(chunkMicSegs), len(chunkSysSegs), len(dialogue))
		}
	}

	// Сохраняем метаданные сессии
	metaPath := filepath.Join(session.DataDir, "meta.json")
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
		ID:            session.ID,
		StartTime:     session.StartTime,
		EndTime:       session.EndTime,
		Status:        session.Status,
		Language:      session.Language,
		Model:         session.Model,
		TotalDuration: int64(session.TotalDuration / time.Millisecond),
		SampleCount:   session.SampleCount,
		ChunksCount:   len(session.Chunks),
	}
	data, _ := json.MarshalIndent(meta, "", "  ")
	os.WriteFile(metaPath, data, 0644)

	return nil
}

// UpdateFullTranscriptionMono обновляет сессию с полной транскрипцией (моно режим)
// ВАЖНО: Сохраняет структуру чанков, обновляя каждый чанк отдельно
func (m *Manager) UpdateFullTranscriptionMono(sessionID string, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	log.Printf("UpdateFullTranscriptionMono: session %s has %d chunks, text=%d chars",
		sessionID, len(session.Chunks), len(text))

	// Если нет существующих чанков, создаём один с полной транскрипцией
	if len(session.Chunks) == 0 {
		now := time.Now()
		chunk := &Chunk{
			ID:            uuid.New().String(),
			SessionID:     sessionID,
			Index:         0,
			StartMs:       0,
			EndMs:         session.TotalDuration.Milliseconds(),
			Duration:      session.TotalDuration,
			IsStereo:      false,
			Status:        ChunkStatusCompleted,
			CreatedAt:     now,
			TranscribedAt: &now,
			Transcription: text,
		}
		session.Chunks = []*Chunk{chunk}

		// Сохраняем метаданные чанка
		chunkMetaPath := filepath.Join(session.DataDir, "chunks", "000.json")
		data, _ := json.MarshalIndent(chunk, "", "  ")
		os.WriteFile(chunkMetaPath, data, 0644)
	} else {
		// Для моно режима пока просто обновляем все чанки с полным текстом
		// TODO: В будущем можно разбить текст по чанкам на основе timestamps
		for _, chunk := range session.Chunks {
			now := time.Now()
			chunk.TranscribedAt = &now
			chunk.Status = ChunkStatusCompleted
			chunk.Error = ""
			chunk.Transcription = text
			chunk.MicText = ""
			chunk.SysText = ""
			chunk.MicSegments = nil
			chunk.SysSegments = nil
			chunk.Dialogue = nil

			// Сохраняем метаданные чанка
			chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
			data, _ := json.MarshalIndent(chunk, "", "  ")
			os.WriteFile(chunkMetaPath, data, 0644)
		}
	}

	log.Printf("UpdateFullTranscriptionMono: session %s updated", sessionID)

	// Сохраняем метаданные сессии
	metaPath := filepath.Join(session.DataDir, "meta.json")
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
		ID:            session.ID,
		StartTime:     session.StartTime,
		EndTime:       session.EndTime,
		Status:        session.Status,
		Language:      session.Language,
		Model:         session.Model,
		TotalDuration: int64(session.TotalDuration / time.Millisecond),
		SampleCount:   session.SampleCount,
		ChunksCount:   len(session.Chunks),
	}
	metaData, _ := json.MarshalIndent(meta, "", "  ")
	os.WriteFile(metaPath, metaData, 0644)

	return nil
}

// UpdateSpeakerName переименовывает спикера во всех сегментах сессии
func (m *Manager) UpdateSpeakerName(sessionID string, oldName, newName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	// Обновляем имя спикера во всех чанках
	for _, chunk := range session.Chunks {
		modified := false

		// Dialogue
		for i := range chunk.Dialogue {
			if chunk.Dialogue[i].Speaker == oldName {
				chunk.Dialogue[i].Speaker = newName
				modified = true
			}
		}

		// SysSegments
		for i := range chunk.SysSegments {
			if chunk.SysSegments[i].Speaker == oldName {
				chunk.SysSegments[i].Speaker = newName
				modified = true
			}
		}

		// MicSegments
		for i := range chunk.MicSegments {
			if chunk.MicSegments[i].Speaker == oldName {
				chunk.MicSegments[i].Speaker = newName
				modified = true
			}
		}

		// Сохраняем чанк если был изменён
		if modified {
			chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
			data, _ := json.MarshalIndent(chunk, "", "  ")
			os.WriteFile(chunkMetaPath, data, 0644)
		}
	}

	log.Printf("UpdateSpeakerName: session %s, '%s' -> '%s'", sessionID, oldName, newName)
	return nil
}

// UpdateImprovedDialogue обновляет диалог сессии улучшенной версией от LLM
// Распределяет улучшенный диалог по всем чанкам на основе timestamps
func (m *Manager) UpdateImprovedDialogue(sessionID string, improvedDialogue []TranscriptSegment) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[sessionID]
	if !ok {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if len(session.Chunks) == 0 {
		return fmt.Errorf("session has no chunks")
	}

	// Если только один чанк - просто обновляем его
	if len(session.Chunks) == 1 {
		chunk := session.Chunks[0]
		chunk.Dialogue = improvedDialogue
		chunk.Transcription = formatDialogue(improvedDialogue)

		chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
		data, _ := json.MarshalIndent(chunk, "", "  ")
		os.WriteFile(chunkMetaPath, data, 0644)

		log.Printf("UpdateImprovedDialogue: session %s (single chunk) updated with %d improved segments", sessionID, len(improvedDialogue))
		return nil
	}

	// Для нескольких чанков - распределяем сегменты по чанкам на основе timestamps
	// Сначала собираем информацию о временных диапазонах чанков
	type chunkRange struct {
		chunk   *Chunk
		startMs int64
		endMs   int64
	}

	var chunkRanges []chunkRange
	var currentOffset int64 = 0

	for _, chunk := range session.Chunks {
		durationMs := int64(chunk.Duration / time.Millisecond) // time.Duration -> миллисекунды
		chunkRanges = append(chunkRanges, chunkRange{
			chunk:   chunk,
			startMs: currentOffset,
			endMs:   currentOffset + durationMs,
		})
		currentOffset += durationMs
	}

	// Распределяем сегменты по чанкам
	chunkDialogues := make(map[int][]TranscriptSegment)

	for _, seg := range improvedDialogue {
		// Находим чанк, в который попадает этот сегмент
		for i, cr := range chunkRanges {
			// Сегмент попадает в чанк если его начало в диапазоне чанка
			if seg.Start >= cr.startMs && seg.Start < cr.endMs {
				chunkDialogues[i] = append(chunkDialogues[i], seg)
				break
			}
		}
	}

	// Обновляем каждый чанк
	for i, chunk := range session.Chunks {
		if dialogue, ok := chunkDialogues[i]; ok && len(dialogue) > 0 {
			chunk.Dialogue = dialogue
			chunk.Transcription = formatDialogue(dialogue)
		}
		// Сохраняем метаданные чанка
		chunkMetaPath := filepath.Join(session.DataDir, "chunks", fmt.Sprintf("%03d.json", chunk.Index))
		data, _ := json.MarshalIndent(chunk, "", "  ")
		os.WriteFile(chunkMetaPath, data, 0644)
	}

	log.Printf("UpdateImprovedDialogue: session %s updated %d chunks with %d total improved segments",
		sessionID, len(session.Chunks), len(improvedDialogue))

	return nil
}
