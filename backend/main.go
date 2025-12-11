package main

import (
	"aiwisper/ai"
	"aiwisper/audio"
	"aiwisper/internal/api"
	"aiwisper/internal/config"
	"aiwisper/internal/service"
	"aiwisper/models"
	"aiwisper/session"
	"aiwisper/voiceprint"
	"fmt"
	"io"
	"log"
	"os"
)

func main() {
	// 1. Load Configuration
	cfg := config.Load()

	logFile := setupLogging(cfg.TraceLog)
	if logFile != nil {
		defer logFile.Close()
	}

	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC: %v", r)
			panic(r)
		}
	}()

	// Ensure directories exist
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		log.Fatal("Failed to create data directory:", err)
	}
	if err := os.MkdirAll(cfg.ModelsDir, 0755); err != nil {
		log.Fatal("Failed to create models directory:", err)
	}

	// 2. Initialize Managers
	sessionMgr, err := session.NewManager(cfg.DataDir)
	if err != nil {
		log.Fatal("Failed to create session manager:", err)
	}

	modelMgr, err := models.NewManager(cfg.ModelsDir)
	if err != nil {
		log.Fatal("Failed to create model manager:", err)
	}

	engineMgr := ai.NewEngineManager(modelMgr)

	// Try to set default model
	if cfg.ModelPath != "" {
		if err := engineMgr.SetActiveModel(cfg.ModelPath); err != nil {
			log.Printf("Note: Initial model %s could not be loaded (may need download): %v", cfg.ModelPath, err)
		}
	}

	// Initialize Audio Capture
	capture, err := audio.NewCapture()
	if err != nil {
		log.Fatal("Failed to initialize audio capture:", err)
	}
	defer capture.Close()

	// 3. Initialize Services
	transcriptionService := service.NewTranscriptionService(sessionMgr, engineMgr)
	recordingService := service.NewRecordingService(sessionMgr, capture)
	llmService := service.NewLLMService()
	streamingTranscriptionService := service.NewStreamingTranscriptionService(modelMgr)

	// Настраиваем LLM для автоулучшения транскрипции
	transcriptionService.SetLLMService(llmService)
	if cfg.AutoImproveWithLLM {
		transcriptionService.EnableAutoImprove(cfg.OllamaURL, cfg.OllamaModel)
	}

	// 4. Initialize VoicePrint Store for speaker recognition
	vpStore, err := voiceprint.NewStore(cfg.DataDir)
	if err != nil {
		log.Printf("Warning: Failed to initialize voiceprint store: %v", err)
		// Продолжаем без voiceprint - не критично
	}
	var vpMatcher *voiceprint.Matcher
	if vpStore != nil {
		vpMatcher = voiceprint.NewMatcher(vpStore)
	}

	// 5. Initialize API Server
	server := api.NewServer(cfg, sessionMgr, engineMgr, modelMgr, capture, transcriptionService, recordingService, llmService, streamingTranscriptionService, vpStore, vpMatcher)

	// 5. Start Server
	log.Println("Starting AIWisper Backend...")
	server.Start()
}

func setupLogging(path string) *os.File {
	if path == "" {
		return nil
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open trace log %s: %v\n", path, err)
		return nil
	}

	log.SetOutput(io.MultiWriter(os.Stdout, file))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.Lshortfile)
	log.Printf("trace log attached: %s", path)

	return file
}
