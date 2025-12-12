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
func TestVoteByHotwords(t *testing.T) {
	hotwords := []string{"Genesis", "API", "B2C", "Kubernetes", "Docker"}

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
			primary:   "API",
			secondary: "апи",
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
			primary:   "API",
			secondary: "Docker",
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
func TestMatchesHotword(t *testing.T) {
	hotwords := []string{"Genesis", "Kubernetes", "Docker", "API"}

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
		{"Gen", false, ""},           // too different
		{"Kubernetes", true, "Kubernetes"},
		{"kubernetes", true, "Kubernetes"},
		{"kubernete", true, "Kubernetes"}, // 1 char missing
		{"Docker", true, "Docker"},
		{"docker", true, "Docker"},
		{"Doker", true, "Docker"}, // 1 char difference
		{"API", true, "API"},
		{"api", true, "API"},
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
