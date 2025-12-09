package config

import (
	"flag"
	"path/filepath"
)

type Config struct {
	ModelPath string
	DataDir   string
	ModelsDir string
	Port      string
}

func Load() *Config {
	modelPath := flag.String("model", "ggml-base.bin", "Path to Whisper model")
	dataDir := flag.String("data", "data/sessions", "Directory for session data")
	modelsDir := flag.String("models", "", "Directory for downloaded models (default: dataDir/../models)")
	port := flag.String("port", "8080", "Server port")
	flag.Parse()

	// Determine models directory
	finalModelsDir := *modelsDir
	if finalModelsDir == "" {
		finalModelsDir = filepath.Join(filepath.Dir(*dataDir), "models")
	}

	return &Config{
		ModelPath: *modelPath,
		DataDir:   *dataDir,
		ModelsDir: finalModelsDir,
		Port:      *port,
	}
}
