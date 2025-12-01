package whisper

import (
	"errors"
	"unsafe"
)

///////////////////////////////////////////////////////////////////////////////
// CGO

/*
#include "whisper.h"
*/
import "C"

///////////////////////////////////////////////////////////////////////////////
// ERRORS

var (
	ErrUnableToLoadModel    = errors.New("unable to load model")
	ErrInternalAppError     = errors.New("internal application error")
	ErrProcessingFailed     = errors.New("processing failed")
	ErrUnsupportedLanguage  = errors.New("unsupported language")
	ErrModelNotMultilingual = errors.New("model is not multilingual")
)

///////////////////////////////////////////////////////////////////////////////
// CONSTANTS

// SampleRate is the sample rate of the audio data.
const SampleRate = C.WHISPER_SAMPLE_RATE

// SampleBits is the number of bytes per sample.
const SampleBits = uint16(unsafe.Sizeof(C.float(0))) * 8

// NumFFT is the number of FFT bins.
const NumFFT = C.WHISPER_N_FFT

// HopLength is the hop length.
const HopLength = C.WHISPER_HOP_LENGTH

// ChunkSize is the chunk size.
const ChunkSize = C.WHISPER_CHUNK_SIZE
