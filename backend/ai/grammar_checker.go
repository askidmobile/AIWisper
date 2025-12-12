// Package ai предоставляет grammar checker для проверки корректности слов
package ai

import (
	"bufio"
	"embed"
	"log"
	"strings"
	"sync"
)

//go:embed dictionaries/*.txt
var dictionariesFS embed.FS

// SimpleGrammarChecker простая реализация GrammarChecker через словари
// Использует встроенные словари для русского и английского языков
type SimpleGrammarChecker struct {
	russianWords map[string]bool
	englishWords map[string]bool
	mu           sync.RWMutex
	initialized  bool
}

// NewSimpleGrammarChecker создаёт новый SimpleGrammarChecker
func NewSimpleGrammarChecker() *SimpleGrammarChecker {
	checker := &SimpleGrammarChecker{
		russianWords: make(map[string]bool),
		englishWords: make(map[string]bool),
	}
	checker.loadDictionaries()
	return checker
}

// loadDictionaries загружает словари из embedded файлов
func (c *SimpleGrammarChecker) loadDictionaries() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.initialized {
		return
	}

	// Загружаем русский словарь
	ruCount := c.loadDictionary("dictionaries/russian_words.txt", c.russianWords)
	log.Printf("[GrammarChecker] Loaded %d Russian words", ruCount)

	// Загружаем английский словарь
	enCount := c.loadDictionary("dictionaries/english_words.txt", c.englishWords)
	log.Printf("[GrammarChecker] Loaded %d English words", enCount)

	c.initialized = true
}

// loadDictionary загружает словарь из файла
func (c *SimpleGrammarChecker) loadDictionary(path string, dict map[string]bool) int {
	data, err := dictionariesFS.ReadFile(path)
	if err != nil {
		log.Printf("[GrammarChecker] Warning: could not load dictionary %s: %v", path, err)
		return 0
	}

	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	count := 0
	for scanner.Scan() {
		word := strings.TrimSpace(scanner.Text())
		if word != "" && !strings.HasPrefix(word, "#") {
			dict[strings.ToLower(word)] = true
			count++
		}
	}
	return count
}

// IsValidWord проверяет, является ли слово корректным
func (c *SimpleGrammarChecker) IsValidWord(word string, lang string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Нормализуем слово
	word = strings.ToLower(strings.Trim(word, ".,!?;:\"'()-–—"))
	if word == "" {
		return true // Пустые слова считаем валидными
	}

	// Числа считаем валидными
	if isNumeric(word) {
		return true
	}

	// Выбираем словарь по языку
	switch lang {
	case "ru":
		return c.russianWords[word]
	case "en":
		return c.englishWords[word]
	default:
		// Автоопределение: проверяем в обоих словарях
		if containsCyrillic(word) {
			return c.russianWords[word]
		}
		return c.englishWords[word]
	}
}

// Close освобождает ресурсы
func (c *SimpleGrammarChecker) Close() error {
	return nil
}

// AddWord добавляет слово в словарь (runtime)
func (c *SimpleGrammarChecker) AddWord(word string, lang string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	word = strings.ToLower(word)
	switch lang {
	case "ru":
		c.russianWords[word] = true
	case "en":
		c.englishWords[word] = true
	default:
		if containsCyrillic(word) {
			c.russianWords[word] = true
		} else {
			c.englishWords[word] = true
		}
	}
}

// AddWords добавляет несколько слов в словарь
func (c *SimpleGrammarChecker) AddWords(words []string, lang string) {
	for _, word := range words {
		c.AddWord(word, lang)
	}
}

// isNumeric проверяет, является ли строка числом
func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Проверяем что SimpleGrammarChecker реализует GrammarChecker
var _ GrammarChecker = (*SimpleGrammarChecker)(nil)
