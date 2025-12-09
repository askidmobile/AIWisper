package config

import (
	"flag"
	"path/filepath"
	"runtime"
)

type Config struct {
	ModelPath string
	DataDir   string
	ModelsDir string
	Port      string
	GRPCAddr  string

	// LLM настройки
	OllamaURL          string // URL Ollama API (по умолчанию http://localhost:11434)
	OllamaModel        string // Модель для улучшения транскрипции
	AutoImproveWithLLM bool   // Автоматически улучшать транскрипцию через LLM
}

func Load() *Config {
	modelPath := flag.String("model", "ggml-base.bin", "Path to Whisper model")
	dataDir := flag.String("data", "data/sessions", "Directory for session data")
	modelsDir := flag.String("models", "", "Directory for downloaded models (default: dataDir/../models)")
	port := flag.String("port", "8080", "Server port")
	grpcAddr := flag.String("grpc-addr", defaultGRPCAddress(), "gRPC listen address (unix:/path/to.sock or npipe:////./pipe/aiwisper-grpc)")

	// LLM настройки
	ollamaURL := flag.String("ollama-url", "http://localhost:11434", "Ollama API URL")
	ollamaModel := flag.String("ollama-model", "llama3.2", "Ollama model for transcription improvement")
	autoImprove := flag.Bool("auto-improve", false, "Auto-improve transcription with LLM")

	flag.Parse()

	// Determine models directory
	finalModelsDir := *modelsDir
	if finalModelsDir == "" {
		finalModelsDir = filepath.Join(filepath.Dir(*dataDir), "models")
	}

	return &Config{
		ModelPath:          *modelPath,
		DataDir:            *dataDir,
		ModelsDir:          finalModelsDir,
		Port:               *port,
		GRPCAddr:           *grpcAddr,
		OllamaURL:          *ollamaURL,
		OllamaModel:        *ollamaModel,
		AutoImproveWithLLM: *autoImprove,
	}
}

func defaultGRPCAddress() string {
	if runtime.GOOS == "windows" {
		return "npipe:\\\\.\\pipe\\aiwisper-grpc"
	}
	return "unix:/tmp/aiwisper-grpc.sock"
}
