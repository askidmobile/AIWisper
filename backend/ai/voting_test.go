package ai

import (
	"testing"
)

// TestVoteByCalibration тестирует критерий A - калиброванный confidence
func TestVoteByCalibration(t *testing.T) {
	calibrations := DefaultCalibrations

	tests := []struct {
		name           string
		primaryConf    float32
		secondaryConf  float32
		primaryModel   string
		secondaryModel string
		expected       string
	}{
		{
			name:           "GigaAM high conf vs Parakeet lower conf - Parakeet wins after calibration",
			primaryConf:    0.95,
			secondaryConf:  0.80,
			primaryModel:   "GigaAM-v3-e2e-ctc",
			secondaryModel: "Parakeet-TDT-v3",
			expected:       "secondary", // 0.95*0.75=0.7125 < 0.80*1.0=0.80
		},
		{
			name:           "GigaAM very high conf vs Parakeet low conf - GigaAM wins",
			primaryConf:    0.99,
			secondaryConf:  0.60,
			primaryModel:   "GigaAM-v3-ctc",
			secondaryModel: "Parakeet-TDT-v3",
			expected:       "primary", // 0.99*0.75=0.7425 > 0.60*1.0=0.60
		},
		{
			name:           "Whisper vs Parakeet - no calibration difference",
			primaryConf:    0.85,
			secondaryConf:  0.80,
			primaryModel:   "whisper-large-v3",
			secondaryModel: "Parakeet-TDT-v3",
			expected:       "primary", // 0.85*1.0=0.85 > 0.80*1.0=0.80
		},
		{
			name:           "Equal calibrated confidence - tie",
			primaryConf:    0.80,
			secondaryConf:  0.60,
			primaryModel:   "GigaAM-v3-ctc",
			secondaryModel: "Parakeet-TDT-v3",
			expected:       "tie", // 0.80*0.75=0.60 ≈ 0.60*1.0=0.60
		},
		{
			name:           "Unknown model - no calibration applied",
			primaryConf:    0.70,
			secondaryConf:  0.80,
			primaryModel:   "unknown-model",
			secondaryModel: "another-unknown",
			expected:       "secondary", // 0.70*1.0=0.70 < 0.80*1.0=0.80
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			primary := TranscriptWord{P: tt.primaryConf}
			secondary := TranscriptWord{P: tt.secondaryConf}

			result := voteByCalibration(primary, secondary, tt.primaryModel, tt.secondaryModel, calibrations)

			if result != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, result)
			}
		})
	}
}

// TestVoteByLatin тестирует критерий B - детекция латиницы
func TestVoteByLatin(t *testing.T) {
	tests := []struct {
		name      string
		primary   string
		secondary string
		expected  string
	}{
		{
			name:      "Cyrillic vs Latin - Latin wins",
			primary:   "джинезис",
			secondary: "Genesis",
			expected:  "secondary",
		},
		{
			name:      "Latin vs Cyrillic - Latin wins",
			primary:   "Genesis",
			secondary: "джинезис",
			expected:  "primary",
		},
		{
			name:      "Both Cyrillic - abstain",
			primary:   "привет",
			secondary: "здравствуйте",
			expected:  "abstain",
		},
		{
			name:      "Both Latin - abstain",
			primary:   "hello",
			secondary: "world",
			expected:  "abstain",
		},
		{
			name:      "Mixed vs Latin - Latin wins",
			primary:   "апи",
			secondary: "API",
			expected:  "secondary",
		},
		{
			name:      "Cyrillic vs Mixed (has latin) - Mixed wins",
			primary:   "бизнес",
			secondary: "B2B",
			expected:  "secondary",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := voteByLatin(
				TranscriptWord{Text: tt.primary},
				TranscriptWord{Text: tt.secondary},
			)
			if result != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, result)
			}
		})
	}
}

// TestVoteByHotwords тестирует критерий C - совпадение с hotwords
// ВАЖНО: После исправления бага с ложными срабатываниями, короткие hotwords (< 4 символов)
// больше не поддерживаются для fuzzy matching
func TestVoteByHotwords(t *testing.T) {
	// Используем только hotwords >= 4 символов
	hotwords := []string{"Genesis", "Kubernetes", "Docker", "PostgreSQL"}

	tests := []struct {
		name      string
		primary   string
		secondary string
		expected  string
	}{
		{
			name:      "Secondary matches hotword exactly",
			primary:   "джинезис",
			secondary: "Genesis",
			expected:  "secondary",
		},
		{
			name:      "Primary matches hotword exactly",
			primary:   "Docker",
			secondary: "докер",
			expected:  "primary",
		},
		{
			name:      "Secondary matches hotword fuzzy",
			primary:   "дженезис",
			secondary: "Genesi", // close to Genesis
			expected:  "secondary",
		},
		{
			name:      "Neither matches - abstain",
			primary:   "привет",
			secondary: "hello",
			expected:  "abstain",
		},
		{
			name:      "Both match different hotwords - abstain",
			primary:   "Docker",
			secondary: "Genesis",
			expected:  "abstain",
		},
		{
			name:      "Case insensitive match",
			primary:   "кубернетес",
			secondary: "kubernetes",
			expected:  "secondary",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := voteByHotwords(
				TranscriptWord{Text: tt.primary},
				TranscriptWord{Text: tt.secondary},
				hotwords,
			)
			if result != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, result)
			}
		})
	}
}

// TestContainsLatin тестирует функцию containsLatin
func TestContainsLatin(t *testing.T) {
	tests := []struct {
		word     string
		expected bool
	}{
		{"hello", true},
		{"WORLD", true},
		{"привет", false},
		{"ПРИВЕТ", false},
		{"API", true},
		{"апи", false},
		{"B2C", true},
		{"123", false},
		{"", false},
		{"Hello123", true},
		{"Привет123", false},
	}

	for _, tt := range tests {
		t.Run(tt.word, func(t *testing.T) {
			result := containsLatin(tt.word)
			if result != tt.expected {
				t.Errorf("containsLatin(%q) = %v, expected %v", tt.word, result, tt.expected)
			}
		})
	}
}

// TestContainsCyrillic тестирует функцию containsCyrillic
func TestContainsCyrillic(t *testing.T) {
	tests := []struct {
		word     string
		expected bool
	}{
		{"hello", false},
		{"привет", true},
		{"ПРИВЕТ", true},
		{"ёлка", true},
		{"Ёлка", true},
		{"123", false},
		{"", false},
		{"Hello привет", true},
	}

	for _, tt := range tests {
		t.Run(tt.word, func(t *testing.T) {
			result := containsCyrillic(tt.word)
			if result != tt.expected {
				t.Errorf("containsCyrillic(%q) = %v, expected %v", tt.word, result, tt.expected)
			}
		})
	}
}

// TestMatchesHotword тестирует fuzzy matching для hotwords
// ВАЖНО: После исправления бага с ложными срабатываниями, короткие hotwords (< 4 символов)
// больше не поддерживаются для fuzzy matching, только точное совпадение
func TestMatchesHotword(t *testing.T) {
	hotwords := []string{"Genesis", "Kubernetes", "Docker"}

	tests := []struct {
		word           string
		shouldMatch    bool
		matchedHotword string
	}{
		{"Genesis", true, "Genesis"},
		{"genesis", true, "Genesis"},
		{"GENESIS", true, "Genesis"},
		{"Genesi", true, "Genesis"},  // 1 char difference
		{"Genisis", true, "Genesis"}, // 1 char difference
		{"Gen", false, ""},           // too short
		{"Kubernetes", true, "Kubernetes"},
		{"kubernetes", true, "Kubernetes"},
		{"kubernete", true, "Kubernetes"}, // 1 char missing
		{"Docker", true, "Docker"},
		{"docker", true, "Docker"},
		{"Doker", true, "Docker"}, // 1 char difference
		// Короткие hotwords (API - 3 символа) теперь не поддерживаются для fuzzy matching
		// чтобы избежать ложных срабатываний типа "с" -> "МТС"
		{"random", false, ""},
		{"привет", false, ""},
	}

	for _, tt := range tests {
		t.Run(tt.word, func(t *testing.T) {
			matches, matched := matchesHotword(tt.word, hotwords)
			if matches != tt.shouldMatch {
				t.Errorf("matchesHotword(%q) = %v, expected %v", tt.word, matches, tt.shouldMatch)
			}
			if matches && matched != tt.matchedHotword {
				t.Errorf("matchesHotword(%q) matched %q, expected %q", tt.word, matched, tt.matchedHotword)
			}
		})
	}
}

// TestGetCalibrationFactor тестирует получение коэффициента калибровки
func TestGetCalibrationFactor(t *testing.T) {
	calibrations := DefaultCalibrations

	tests := []struct {
		modelName string
		expected  float32
	}{
		{"GigaAM-v3-e2e-ctc", 0.75},
		{"gigaam-v3-ctc", 0.75},
		{"GIGAAM", 0.75},
		{"whisper-large-v3", 1.0},
		{"Whisper-Large-V3-Turbo", 1.0},
		{"parakeet-tdt-v3", 1.0},
		{"Parakeet-TDT-v3-Multilingual", 1.0},
		{"fluid-audio", 1.0},
		{"unknown-model", 1.0}, // default
		{"", 1.0},              // empty
	}

	for _, tt := range tests {
		t.Run(tt.modelName, func(t *testing.T) {
			result := getCalibrationFactor(tt.modelName, calibrations)
			if result != tt.expected {
				t.Errorf("getCalibrationFactor(%q) = %v, expected %v", tt.modelName, result, tt.expected)
			}
		})
	}
}

// TestSimpleGrammarChecker тестирует grammar checker
func TestSimpleGrammarChecker(t *testing.T) {
	checker := NewSimpleGrammarChecker()
	defer checker.Close()

	tests := []struct {
		word     string
		lang     string
		expected bool
	}{
		// Английские слова
		{"hello", "en", true},
		{"world", "en", true},
		{"api", "en", true},
		{"kubernetes", "en", true},
		{"xyzabc123", "en", false},

		// Русские слова
		{"привет", "ru", true},
		{"работа", "ru", true},
		{"система", "ru", true},
		{"йцукенг", "ru", false},

		// Автоопределение языка
		{"hello", "", true},
		{"привет", "", true},

		// Числа - всегда валидны
		{"123", "", true},
		{"456", "ru", true},
		{"789", "en", true},

		// Пустые строки
		{"", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.word+"_"+tt.lang, func(t *testing.T) {
			result := checker.IsValidWord(tt.word, tt.lang)
			if result != tt.expected {
				t.Errorf("IsValidWord(%q, %q) = %v, expected %v", tt.word, tt.lang, result, tt.expected)
			}
		})
	}
}

// TestNormalizeWordForComparison тестирует нормализацию слов
func TestNormalizeWordForComparison(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"Hello", "hello"},
		{"WORLD", "world"},
		{"Hello!", "hello"},
		{"Hello.", "hello"},
		{"Hello,", "hello"},
		{"(Hello)", "hello"},
		{"\"Hello\"", "hello"},
		{"Hello—World", "hello—world"},
		{"  hello  ", "hello"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := normalizeWordForComparison(tt.input)
			if result != tt.expected {
				t.Errorf("normalizeWordForComparison(%q) = %q, expected %q", tt.input, result, tt.expected)
			}
		})
	}
}

// TestDefaultVotingConfig проверяет дефолтную конфигурацию
func TestDefaultVotingConfig(t *testing.T) {
	config := DefaultVotingConfig()

	if !config.Enabled {
		t.Error("Expected Enabled to be true by default")
	}
	if !config.UseCalibration {
		t.Error("Expected UseCalibration to be true by default")
	}
	if !config.UseLatinDetection {
		t.Error("Expected UseLatinDetection to be true by default")
	}
	if !config.UseHotwords {
		t.Error("Expected UseHotwords to be true by default")
	}
	if !config.UseGrammarCheck {
		t.Error("Expected UseGrammarCheck to be true by default")
	}
	if len(config.Calibrations) == 0 {
		t.Error("Expected Calibrations to have default values")
	}
}

// BenchmarkVoteByCalibration бенчмарк для критерия калибровки
func BenchmarkVoteByCalibration(b *testing.B) {
	calibrations := DefaultCalibrations
	primary := TranscriptWord{P: 0.95}
	secondary := TranscriptWord{P: 0.80}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		voteByCalibration(primary, secondary, "GigaAM-v3-e2e-ctc", "Parakeet-TDT-v3", calibrations)
	}
}

// BenchmarkVoteByLatin бенчмарк для критерия латиницы
func BenchmarkVoteByLatin(b *testing.B) {
	primary := TranscriptWord{Text: "джинезис"}
	secondary := TranscriptWord{Text: "Genesis"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		voteByLatin(primary, secondary)
	}
}

// BenchmarkVoteByHotwords бенчмарк для критерия hotwords
func BenchmarkVoteByHotwords(b *testing.B) {
	hotwords := []string{"Genesis", "API", "B2C", "Kubernetes", "Docker", "PostgreSQL", "MongoDB", "Redis"}
	primary := TranscriptWord{Text: "джинезис"}
	secondary := TranscriptWord{Text: "Genesis"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		voteByHotwords(primary, secondary, hotwords)
	}
}

// BenchmarkGrammarChecker бенчмарк для grammar checker
func BenchmarkGrammarChecker(b *testing.B) {
	checker := NewSimpleGrammarChecker()
	defer checker.Close()

	words := []string{"hello", "world", "привет", "работа", "api", "kubernetes"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, word := range words {
			checker.IsValidWord(word, "")
		}
	}
}

// TestMatchesHotwordNoFalsePositives проверяет что короткие слова НЕ матчатся с hotwords
// Это критический тест для предотвращения бага "МТС" -> замена "с", "то", "что", "мы"
func TestMatchesHotwordNoFalsePositives(t *testing.T) {
	hotwords := []string{"МТС", "API", "B2C", "ВТБ", "РЖД"}

	// Эти слова НЕ должны матчиться с hotwords, несмотря на маленькое расстояние Левенштейна
	shortWords := []string{
		"с",      // dist=2 до "МТС"
		"то",     // dist=2 до "МТС"
		"что",    // dist=2 до "МТС"
		"мы",     // dist=2 до "МТС"
		"это",    // dist=2 до "МТС"
		"я",      // dist=2 до "МТС"
		"он",     // dist=2 до "МТС"
		"она",    // dist=2 до "МТС"
		"они",    // dist=2 до "МТС"
		"вы",     // dist=2 до "ВТБ"
		"ты",     // dist=2 до "ВТБ"
		"да",     // dist=2 до "РЖД"
		"не",     // короткое слово
		"и",      // короткое слово
		"в",      // короткое слово
		"на",     // короткое слово
		"по",     // короткое слово
		"за",     // короткое слово
		"от",     // короткое слово
		"до",     // короткое слово
		"как",    // короткое слово
		"так",    // короткое слово
		"тут",    // короткое слово
		"там",    // короткое слово
		"где",    // короткое слово
		"кто",    // короткое слово
		"все",    // короткое слово
		"вот",    // короткое слово
		"еще",    // короткое слово
		"уже",    // короткое слово
		"есть",   // короткое слово
		"быть",   // короткое слово
		"скинул", // не должно матчиться ни с чем
		"знаю",   // не должно матчиться ни с чем
	}

	for _, word := range shortWords {
		t.Run(word, func(t *testing.T) {
			matches, matched := matchesHotword(word, hotwords)
			if matches {
				t.Errorf("ЛОЖНОЕ СРАБАТЫВАНИЕ: короткое слово %q не должно матчиться с hotword %q", word, matched)
			}
		})
	}
}

// TestAlignWordsNeedlemanWunsch тестирует алгоритм выравнивания слов
func TestAlignWordsNeedlemanWunsch(t *testing.T) {
	tests := []struct {
		name              string
		primary           []string
		secondary         []string
		expectedAligned   int // Количество выровненных пар (не gaps)
		expectedSimilar   int // Количество похожих пар
		checkSpecificPair bool
		specificPrimary   string
		specificSecondary string
	}{
		{
			name:            "Identical sequences",
			primary:         []string{"привет", "мир"},
			secondary:       []string{"привет", "мир"},
			expectedAligned: 2,
			expectedSimilar: 2,
		},
		{
			name:            "One word different",
			primary:         []string{"привет", "мир", "тест"},
			secondary:       []string{"привет", "world", "тест"},
			expectedAligned: 3,
			expectedSimilar: 2, // "мир" и "world" не похожи
		},
		{
			name:            "Secondary has extra word",
			primary:         []string{"привет", "тест"},
			secondary:       []string{"привет", "мир", "тест"},
			expectedAligned: 2, // привет-привет, тест-тест
			expectedSimilar: 2,
		},
		{
			name:            "Primary has extra word",
			primary:         []string{"привет", "мир", "тест"},
			secondary:       []string{"привет", "тест"},
			expectedAligned: 2, // привет-привет, тест-тест
			expectedSimilar: 2,
		},
		{
			name:            "Similar words with typos",
			primary:         []string{"контур", "RTM"},
			secondary:       []string{"контуре", "RTM"},
			expectedAligned: 2,
			expectedSimilar: 2, // "контур" и "контуре" похожи
		},
		{
			name:            "Completely different sequences",
			primary:         []string{"один", "два", "три"},
			secondary:       []string{"four", "five", "six"},
			expectedAligned: 3,
			expectedSimilar: 0, // Ничего не похоже
		},
		{
			name:              "Real case: shifted words",
			primary:           []string{"и", "вообще", "работы", "EP", "адаптера", "контур", "RTM"},
			secondary:         []string{"перспективы", "общей", "работы", "EPI-адаптера", "контуре", "RTM"},
			expectedAligned:   6, // Некоторые слова выровняются
			expectedSimilar:   4, // работы-работы, адаптера-EPI-адаптера, контур-контуре, RTM-RTM
			checkSpecificPair: true,
			specificPrimary:   "RTM",
			specificSecondary: "RTM",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Создаём TranscriptWord из строк
			primary := make([]TranscriptWord, len(tt.primary))
			for i, w := range tt.primary {
				primary[i] = TranscriptWord{Text: w, P: 0.9}
			}
			secondary := make([]TranscriptWord, len(tt.secondary))
			for i, w := range tt.secondary {
				secondary[i] = TranscriptWord{Text: w, P: 0.9}
			}

			alignment := alignWordsNeedlemanWunsch(primary, secondary)

			// Считаем выровненные пары (не gaps)
			alignedCount := 0
			similarCount := 0
			foundSpecificPair := false

			for _, align := range alignment {
				if align.PrimaryIdx >= 0 && align.SecondaryIdx >= 0 {
					alignedCount++
					if align.IsSimilar {
						similarCount++
					}
					// Проверяем конкретную пару если нужно
					if tt.checkSpecificPair {
						if tt.primary[align.PrimaryIdx] == tt.specificPrimary &&
							tt.secondary[align.SecondaryIdx] == tt.specificSecondary {
							foundSpecificPair = true
						}
					}
				}
			}

			if similarCount != tt.expectedSimilar {
				t.Errorf("Expected %d similar pairs, got %d", tt.expectedSimilar, similarCount)
				// Выводим детали для отладки
				for _, align := range alignment {
					if align.PrimaryIdx >= 0 && align.SecondaryIdx >= 0 {
						t.Logf("  Aligned: '%s' <-> '%s' (similar=%v)",
							tt.primary[align.PrimaryIdx],
							tt.secondary[align.SecondaryIdx],
							align.IsSimilar)
					}
				}
			}

			if tt.checkSpecificPair && !foundSpecificPair {
				t.Errorf("Expected to find pair '%s' <-> '%s' but didn't",
					tt.specificPrimary, tt.specificSecondary)
			}
		})
	}
}

// TestAlignWordsPreservesOrder проверяет что выравнивание сохраняет порядок слов
func TestAlignWordsPreservesOrder(t *testing.T) {
	primary := []TranscriptWord{
		{Text: "один", P: 0.9},
		{Text: "два", P: 0.9},
		{Text: "три", P: 0.9},
		{Text: "четыре", P: 0.9},
	}
	secondary := []TranscriptWord{
		{Text: "один", P: 0.9},
		{Text: "два", P: 0.9},
		{Text: "три", P: 0.9},
		{Text: "четыре", P: 0.9},
	}

	alignment := alignWordsNeedlemanWunsch(primary, secondary)

	// Проверяем что индексы идут по порядку
	lastPrimaryIdx := -1
	lastSecondaryIdx := -1

	for _, align := range alignment {
		if align.PrimaryIdx >= 0 {
			if align.PrimaryIdx <= lastPrimaryIdx {
				t.Errorf("Primary indices not in order: %d after %d", align.PrimaryIdx, lastPrimaryIdx)
			}
			lastPrimaryIdx = align.PrimaryIdx
		}
		if align.SecondaryIdx >= 0 {
			if align.SecondaryIdx <= lastSecondaryIdx {
				t.Errorf("Secondary indices not in order: %d after %d", align.SecondaryIdx, lastSecondaryIdx)
			}
			lastSecondaryIdx = align.SecondaryIdx
		}
	}
}

// TestAreWordsSimilar тестирует функцию сравнения слов
func TestAreWordsSimilar(t *testing.T) {
	tests := []struct {
		word1    string
		word2    string
		expected bool
	}{
		// Идентичные слова
		{"привет", "привет", true},
		{"hello", "hello", true},

		// Разный регистр
		{"Hello", "hello", true},
		{"ПРИВЕТ", "привет", true},

		// Пунктуация
		{"привет.", "привет", true},
		{"привет,", "привет", true},
		{"(привет)", "привет", true},

		// Небольшие опечатки
		{"контур", "контуре", true},
		{"работы", "работа", true},
		{"RTM", "RTM,", true},

		// Совершенно разные слова
		{"привет", "мир", false},
		{"курсе.", "EPI-адаптер", false},
		{"центральным", "звеном", false},
		{"ну,", "больше", false},
		{"и", "непосредственно", false},

		// Слова разной длины
		{"а", "абракадабра", false},
		{"мы", "мышление", false},
	}

	for _, tt := range tests {
		t.Run(tt.word1+"_vs_"+tt.word2, func(t *testing.T) {
			result := areWordsSimilar(tt.word1, tt.word2)
			if result != tt.expected {
				t.Errorf("areWordsSimilar(%q, %q) = %v, expected %v",
					tt.word1, tt.word2, result, tt.expected)
			}
		})
	}
}

// TestMatchesHotwordValidMatches проверяет что правильные слова матчатся
func TestMatchesHotwordValidMatches(t *testing.T) {
	hotwords := []string{"Kubernetes", "Docker", "Genesis", "PostgreSQL"}

	tests := []struct {
		word           string
		shouldMatch    bool
		matchedHotword string
	}{
		// Точные совпадения
		{"Kubernetes", true, "Kubernetes"},
		{"kubernetes", true, "Kubernetes"},
		{"Docker", true, "Docker"},
		{"docker", true, "Docker"},
		{"Genesis", true, "Genesis"},
		{"genesis", true, "Genesis"},
		{"PostgreSQL", true, "PostgreSQL"},
		{"postgresql", true, "PostgreSQL"},

		// Близкие опечатки (1-2 символа)
		{"Kubernete", true, "Kubernetes"}, // 1 символ
		{"Kuberntes", true, "Kubernetes"}, // 1 символ перестановка
		{"Doker", true, "Docker"},         // 1 символ
		{"Genesi", true, "Genesis"},       // 1 символ
		{"Genisis", true, "Genesis"},      // 1 символ
		{"PostgreSQ", true, "PostgreSQL"}, // 1 символ
		{"Postgresq", true, "PostgreSQL"}, // 1 символ + регистр
		{"Postgreql", true, "PostgreSQL"}, // 1 символ

		// Слишком далёкие - НЕ должны матчиться
		{"Kube", false, ""},      // слишком короткое
		{"Doc", false, ""},       // слишком короткое
		{"Gen", false, ""},       // слишком короткое
		{"Post", false, ""},      // слишком короткое
		{"random", false, ""},    // совсем другое слово
		{"привет", false, ""},    // кириллица
		{"контейнер", false, ""}, // другое слово
	}

	for _, tt := range tests {
		t.Run(tt.word, func(t *testing.T) {
			matches, matched := matchesHotword(tt.word, hotwords)
			if matches != tt.shouldMatch {
				if tt.shouldMatch {
					t.Errorf("Слово %q должно матчиться с hotword, но не матчится", tt.word)
				} else {
					t.Errorf("Слово %q НЕ должно матчиться, но матчится с %q", tt.word, matched)
				}
			}
			if matches && matched != tt.matchedHotword {
				t.Errorf("Слово %q матчится с %q, ожидалось %q", tt.word, matched, tt.matchedHotword)
			}
		})
	}
}
