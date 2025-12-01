//go:build ignore
// +build ignore

package main

import (
	"aiwisper/ai"
	"encoding/binary"
	"fmt"
	"io/ioutil"
	"log"
	"math"
)

func main() {
	modelPath := "ggml-base.bin"
	engine, err := ai.NewEngine(modelPath)
	if err != nil {
		log.Fatalf("Failed to load model: %v", err)
	}
	defer engine.Close()

	// Load raw float32 audio
	data, err := ioutil.ReadFile("test.bin")
	if err != nil {
		log.Fatalf("Failed to read test.bin: %v", err)
	}

	// Convert bytes to float32
	samples := make([]float32, len(data)/4)
	for i := 0; i < len(samples); i++ {
		bits := binary.LittleEndian.Uint32(data[i*4 : (i+1)*4])
		samples[i] = math.Float32frombits(bits)
	}

	fmt.Printf("Loaded %d samples (%.2fs)\n", len(samples), float64(len(samples))/16000.0)

	text, err := engine.Transcribe(samples)
	if err != nil {
		log.Fatalf("Transcribe error: %v", err)
	}

	fmt.Printf("Transcription: %s\n", text)
}
