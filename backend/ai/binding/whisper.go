package whisper

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"
)

///////////////////////////////////////////////////////////////////////////////
// CGO

/*
#cgo LDFLAGS: -lm -lstdc++
#cgo linux LDFLAGS: -fopenmp
#cgo darwin CFLAGS: -I. -I../../whisper.cpp/include -DGGML_USE_METAL -DGGML_USE_CPU
#cgo darwin CXXFLAGS: -I. -I../../whisper.cpp/include -std=c++17 -DGGML_USE_METAL -DGGML_USE_CPU
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/src/libwhisper.a
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/ggml/src/libggml.a
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/ggml/src/libggml-cpu.a
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/ggml/src/ggml-metal/libggml-metal.a
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/ggml/src/libggml-base.a
#cgo darwin LDFLAGS: ${SRCDIR}/../../whisper.cpp/build/ggml/src/ggml-blas/libggml-blas.a
#cgo darwin LDFLAGS: -framework Accelerate -framework Metal -framework MetalKit -framework Foundation -framework CoreGraphics
#cgo CFLAGS: -I. -O3 -D__ARM_NEON -D__ARM_FEATURE_DOTPROD -D__ARM_FEATURE_FMA
#cgo CXXFLAGS: -I. -O3 -std=c++17 -D__ARM_NEON -D__ARM_FEATURE_DOTPROD -D__ARM_FEATURE_FMA
#include <stdlib.h>
#include "whisper.h"

extern void callNewSegment(void* user_data, int new);
extern void callProgress(void* user_data, int progress);
extern bool callEncoderBegin(void* user_data);

// Text segment callback
// Called on every newly generated text segment
// Use the whisper_full_...() functions to obtain the text segments
static void whisper_new_segment_cb(struct whisper_context* ctx, struct whisper_state* state, int n_new, void* user_data) {
    if(user_data != NULL && ctx != NULL) {
        callNewSegment(user_data, n_new);
    }
}

// Progress callback
// Called on every newly generated text segment
// Use the whisper_full_...() functions to obtain the text segments
static void whisper_progress_cb(struct whisper_context* ctx, struct whisper_state* state, int progress, void* user_data) {
    if(user_data != NULL && ctx != NULL) {
        callProgress(user_data, progress);
    }
}

// Encoder begin callback
// If not NULL, called before the encoder starts
// If it returns false, the computation is aborted
static bool whisper_encoder_begin_cb(struct whisper_context* ctx, struct whisper_state* state, void* user_data) {
    if(user_data != NULL && ctx != NULL) {
        return callEncoderBegin(user_data);
    }
    return false;
}

// Get default parameters and set callbacks
static struct whisper_full_params whisper_full_default_params_cb(struct whisper_context* ctx, enum whisper_sampling_strategy strategy) {
	struct whisper_full_params params = whisper_full_default_params(strategy);
	params.new_segment_callback = whisper_new_segment_cb;
	params.new_segment_callback_user_data = (void*)(ctx);
	params.encoder_begin_callback = whisper_encoder_begin_cb;
	params.encoder_begin_callback_user_data = (void*)(ctx);
	params.progress_callback = whisper_progress_cb;
	params.progress_callback_user_data = (void*)(ctx);
	return params;
}
*/
import "C"

///////////////////////////////////////////////////////////////////////////////
// TYPES

type (
	WhisperContext   C.struct_whisper_context
	WhisperToken     C.whisper_token
	WhisperTokenData C.struct_whisper_token_data
	SamplingStrategy C.enum_whisper_sampling_strategy
	WhisperParams    C.struct_whisper_full_params
)

///////////////////////////////////////////////////////////////////////////////
// GLOBALS

const (
	SAMPLING_GREEDY      SamplingStrategy = C.WHISPER_SAMPLING_GREEDY
	SAMPLING_BEAM_SEARCH SamplingStrategy = C.WHISPER_SAMPLING_BEAM_SEARCH
)

var (
	ErrTokenizerFailed  = errors.New("whisper_tokenize failed")
	ErrAutoDetectFailed = errors.New("whisper_lang_auto_detect failed")
	ErrConversionFailed = errors.New("whisper_convert failed")
	ErrInvalidLanguage  = errors.New("invalid language")
)

///////////////////////////////////////////////////////////////////////////////
// PUBLIC METHODS

// Allocates all memory needed for the model and loads the model from the given file.
// Returns NULL on failure.
func Whisper_init(path string) *WhisperContext {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	params := C.whisper_context_default_params()

	C.ggml_backend_load_all()

	device := detectExecutionTarget()
	if !device.useGPU {
		params.use_gpu = C.bool(false)
		params.flash_attn = C.bool(false)
	}
	params.gpu_device = C.int(device.gpuDevice)

	ctx := C.whisper_init_from_file_with_params(cPath, params)
	if ctx == nil {
		return nil
	}

	log.Printf("Whisper backend: device=%s use_gpu=%t flash_attn=%t gpu_device=%d", device.kind, bool(params.use_gpu), bool(params.flash_attn), device.gpuDevice)
	return (*WhisperContext)(ctx)
}

// Frees all memory allocated by the model.
func (ctx *WhisperContext) Whisper_free() {
	C.whisper_free((*C.struct_whisper_context)(ctx))
}

// Convert RAW PCM audio to log mel spectrogram.
// The resulting spectrogram is stored inside the provided whisper context.
func (ctx *WhisperContext) Whisper_pcm_to_mel(data []float32, threads int) error {
	if C.whisper_pcm_to_mel((*C.struct_whisper_context)(ctx), (*C.float)(&data[0]), C.int(len(data)), C.int(threads)) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// This can be used to set a custom log mel spectrogram inside the provided whisper context.
// Use this instead of whisper_pcm_to_mel() if you want to provide your own log mel spectrogram.
// n_mel must be 80
func (ctx *WhisperContext) Whisper_set_mel(data []float32, n_mel int) error {
	if C.whisper_set_mel((*C.struct_whisper_context)(ctx), (*C.float)(&data[0]), C.int(len(data)), C.int(n_mel)) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// Run the Whisper encoder on the log mel spectrogram stored inside the provided whisper context.
// Make sure to call whisper_pcm_to_mel() or whisper_set_mel() first.
// offset can be used to specify the offset of the first frame in the spectrogram.
func (ctx *WhisperContext) Whisper_encode(offset, threads int) error {
	if C.whisper_encode((*C.struct_whisper_context)(ctx), C.int(offset), C.int(threads)) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// Run the Whisper decoder to obtain the logits and probabilities for the next token.
// Make sure to call whisper_encode() first.
// tokens + n_tokens is the provided context for the decoder.
// n_past is the number of tokens to use from previous decoder calls.
func (ctx *WhisperContext) Whisper_decode(tokens []WhisperToken, past, threads int) error {
	if C.whisper_decode((*C.struct_whisper_context)(ctx), (*C.whisper_token)(&tokens[0]), C.int(len(tokens)), C.int(past), C.int(threads)) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// Convert the provided text into tokens. The tokens pointer must be large enough to hold the resulting tokens.
// Returns the number of tokens on success
func (ctx *WhisperContext) Whisper_tokenize(text string, tokens []WhisperToken) (int, error) {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	if n := C.whisper_tokenize((*C.struct_whisper_context)(ctx), cText, (*C.whisper_token)(&tokens[0]), C.int(len(tokens))); n >= 0 {
		return int(n), nil
	} else {
		return 0, ErrTokenizerFailed
	}
}

// Return the id of the specified language, returns -1 if not found
// Examples:
//
//	"de" -> 2
//	"german" -> 2
func (ctx *WhisperContext) Whisper_lang_id(lang string) int {
	return int(C.whisper_lang_id(C.CString(lang)))
}

// Largest language id (i.e. number of available languages - 1)
func Whisper_lang_max_id() int {
	return int(C.whisper_lang_max_id())
}

// Return the short string of the specified language id (e.g. 2 -> "de"),
// returns empty string if not found
func Whisper_lang_str(id int) string {
	return C.GoString(C.whisper_lang_str(C.int(id)))
}

// Use mel data at offset_ms to try and auto-detect the spoken language
// Make sure to call whisper_pcm_to_mel() or whisper_set_mel() first.
// Returns the probabilities of all languages.
// ref: https://github.com/openai/whisper/blob/main/whisper/decoding.py#L18-L69
func (ctx *WhisperContext) Whisper_lang_auto_detect(offset_ms, n_threads int) ([]float32, error) {
	probs := make([]float32, Whisper_lang_max_id()+1)
	if n := int(C.whisper_lang_auto_detect((*C.struct_whisper_context)(ctx), C.int(offset_ms), C.int(n_threads), (*C.float)(&probs[0]))); n < 0 {
		return nil, ErrAutoDetectFailed
	} else {
		return probs, nil
	}
}

func (ctx *WhisperContext) Whisper_n_len() int {
	return int(C.whisper_n_len((*C.struct_whisper_context)(ctx)))
}

func (ctx *WhisperContext) Whisper_n_vocab() int {
	return int(C.whisper_n_vocab((*C.struct_whisper_context)(ctx)))
}

func (ctx *WhisperContext) Whisper_n_text_ctx() int {
	return int(C.whisper_n_text_ctx((*C.struct_whisper_context)(ctx)))
}

func (ctx *WhisperContext) Whisper_n_audio_ctx() int {
	return int(C.whisper_n_audio_ctx((*C.struct_whisper_context)(ctx)))
}

func (ctx *WhisperContext) Whisper_is_multilingual() int {
	return int(C.whisper_is_multilingual((*C.struct_whisper_context)(ctx)))
}

// The probabilities for the next token
//func (ctx *Whisper_context) Whisper_get_probs() []float32 {
//	return (*[1 << 30]float32)(unsafe.Pointer(C.whisper_get_probs((*C.struct_whisper_context)(ctx))))[:ctx.Whisper_n_vocab()]
//}

// Token Id -> String. Uses the vocabulary in the provided context
func (ctx *WhisperContext) Whisper_token_to_str(token WhisperToken) string {
	return C.GoString(C.whisper_token_to_str((*C.struct_whisper_context)(ctx), C.whisper_token(token)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_eot() WhisperToken {
	return WhisperToken(C.whisper_token_eot((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_sot() WhisperToken {
	return WhisperToken(C.whisper_token_sot((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_prev() WhisperToken {
	return WhisperToken(C.whisper_token_prev((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_solm() WhisperToken {
	return WhisperToken(C.whisper_token_solm((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_not() WhisperToken {
	return WhisperToken(C.whisper_token_not((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_beg() WhisperToken {
	return WhisperToken(C.whisper_token_beg((*C.struct_whisper_context)(ctx)))
}

// Special tokens
func (ctx *WhisperContext) Whisper_token_lang(lang_id int) WhisperToken {
	return WhisperToken(C.whisper_token_lang((*C.struct_whisper_context)(ctx), C.int(lang_id)))
}

// Task tokens
func (ctx *WhisperContext) Whisper_token_translate() WhisperToken {
	return WhisperToken(C.whisper_token_translate((*C.struct_whisper_context)(ctx)))
}

// Task tokens
func (ctx *WhisperContext) Whisper_token_transcribe() WhisperToken {
	return WhisperToken(C.whisper_token_transcribe((*C.struct_whisper_context)(ctx)))
}

// Performance information
func (ctx *WhisperContext) Whisper_print_timings() {
	C.whisper_print_timings((*C.struct_whisper_context)(ctx))
}

// Performance information
func (ctx *WhisperContext) Whisper_reset_timings() {
	C.whisper_reset_timings((*C.struct_whisper_context)(ctx))
}

// Print system information
func Whisper_print_system_info() string {
	return C.GoString(C.whisper_print_system_info())
}

// Return default parameters for a strategy
func (ctx *WhisperContext) Whisper_full_default_params(strategy SamplingStrategy) WhisperParams {
	// Get default parameters
	return WhisperParams(C.whisper_full_default_params_cb((*C.struct_whisper_context)(ctx), C.enum_whisper_sampling_strategy(strategy)))
}

// Run the entire model: PCM -> log mel spectrogram -> encoder -> decoder -> text
// Uses the specified decoding strategy to obtain the text.
func (ctx *WhisperContext) Whisper_full(
	params WhisperParams,
	samples []float32,
	encoderBeginCallback func() bool,
	newSegmentCallback func(int),
	progressCallback func(int),
) error {
	registerEncoderBeginCallback(ctx, encoderBeginCallback)
	registerNewSegmentCallback(ctx, newSegmentCallback)
	registerProgressCallback(ctx, progressCallback)
	defer registerEncoderBeginCallback(ctx, nil)
	defer registerNewSegmentCallback(ctx, nil)
	defer registerProgressCallback(ctx, nil)
	if C.whisper_full((*C.struct_whisper_context)(ctx), (C.struct_whisper_full_params)(params), (*C.float)(&samples[0]), C.int(len(samples))) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// Split the input audio in chunks and process each chunk separately using whisper_full()
// It seems this approach can offer some speedup in some cases.
// However, the transcription accuracy can be worse at the beginning and end of each chunk.
func (ctx *WhisperContext) Whisper_full_parallel(params WhisperParams, samples []float32, processors int, encoderBeginCallback func() bool, newSegmentCallback func(int)) error {
	registerEncoderBeginCallback(ctx, encoderBeginCallback)
	registerNewSegmentCallback(ctx, newSegmentCallback)
	defer registerEncoderBeginCallback(ctx, nil)
	defer registerNewSegmentCallback(ctx, nil)

	if C.whisper_full_parallel((*C.struct_whisper_context)(ctx), (C.struct_whisper_full_params)(params), (*C.float)(&samples[0]), C.int(len(samples)), C.int(processors)) == 0 {
		return nil
	} else {
		return ErrConversionFailed
	}
}

// Return the id of the autodetected language, returns -1 if not found
// Added to whisper.cpp in
// https://github.com/ggerganov/whisper.cpp/commit/a1c1583cc7cd8b75222857afc936f0638c5683d6
//
// Examples:
//
//	"de" -> 2
//	"german" -> 2
func (ctx *WhisperContext) Whisper_full_lang_id() int {
	return int(C.whisper_full_lang_id((*C.struct_whisper_context)(ctx)))
}

// Number of generated text segments.
// A segment can be a few words, a sentence, or even a paragraph.
func (ctx *WhisperContext) Whisper_full_n_segments() int {
	return int(C.whisper_full_n_segments((*C.struct_whisper_context)(ctx)))
}

// Get the start and end time of the specified segment.
func (ctx *WhisperContext) Whisper_full_get_segment_t0(segment int) int64 {
	return int64(C.whisper_full_get_segment_t0((*C.struct_whisper_context)(ctx), C.int(segment)))
}

// Get the start and end time of the specified segment.
func (ctx *WhisperContext) Whisper_full_get_segment_t1(segment int) int64 {
	return int64(C.whisper_full_get_segment_t1((*C.struct_whisper_context)(ctx), C.int(segment)))
}

// Get the text of the specified segment.
func (ctx *WhisperContext) Whisper_full_get_segment_text(segment int) string {
	return C.GoString(C.whisper_full_get_segment_text((*C.struct_whisper_context)(ctx), C.int(segment)))
}

// Get number of tokens in the specified segment.
func (ctx *WhisperContext) Whisper_full_n_tokens(segment int) int {
	return int(C.whisper_full_n_tokens((*C.struct_whisper_context)(ctx), C.int(segment)))
}

// Get the token text of the specified token index in the specified segment.
func (ctx *WhisperContext) Whisper_full_get_token_text(segment int, token int) string {
	return C.GoString(C.whisper_full_get_token_text((*C.struct_whisper_context)(ctx), C.int(segment), C.int(token)))
}

// Get the token of the specified token index in the specified segment.
func (ctx *WhisperContext) Whisper_full_get_token_id(segment int, token int) WhisperToken {
	return WhisperToken(C.whisper_full_get_token_id((*C.struct_whisper_context)(ctx), C.int(segment), C.int(token)))
}

// Get token data for the specified token in the specified segment.
// This contains probabilities, timestamps, etc.
func (ctx *WhisperContext) Whisper_full_get_token_data(segment int, token int) WhisperTokenData {
	return WhisperTokenData(C.whisper_full_get_token_data((*C.struct_whisper_context)(ctx), C.int(segment), C.int(token)))
}

// Get the probability of the specified token in the specified segment.
func (ctx *WhisperContext) Whisper_full_get_token_p(segment int, token int) float32 {
	return float32(C.whisper_full_get_token_p((*C.struct_whisper_context)(ctx), C.int(segment), C.int(token)))
}

///////////////////////////////////////////////////////////////////////////////
// CALLBACKS

var (
	cbNewSegment   = make(map[unsafe.Pointer]func(int))
	cbProgress     = make(map[unsafe.Pointer]func(int))
	cbEncoderBegin = make(map[unsafe.Pointer]func() bool)
)

func registerNewSegmentCallback(ctx *WhisperContext, fn func(int)) {
	if fn == nil {
		delete(cbNewSegment, unsafe.Pointer(ctx))
	} else {
		cbNewSegment[unsafe.Pointer(ctx)] = fn
	}
}

func registerProgressCallback(ctx *WhisperContext, fn func(int)) {
	if fn == nil {
		delete(cbProgress, unsafe.Pointer(ctx))
	} else {
		cbProgress[unsafe.Pointer(ctx)] = fn
	}
}

func registerEncoderBeginCallback(ctx *WhisperContext, fn func() bool) {
	if fn == nil {
		delete(cbEncoderBegin, unsafe.Pointer(ctx))
	} else {
		cbEncoderBegin[unsafe.Pointer(ctx)] = fn
	}
}

//export callNewSegment
func callNewSegment(user_data unsafe.Pointer, new C.int) {
	if fn, ok := cbNewSegment[user_data]; ok {
		fn(int(new))
	}
}

//export callProgress
func callProgress(user_data unsafe.Pointer, progress C.int) {
	if fn, ok := cbProgress[user_data]; ok {
		fn(int(progress))
	}
}

//export callEncoderBegin
func callEncoderBegin(user_data unsafe.Pointer) C.bool {
	if fn, ok := cbEncoderBegin[user_data]; ok {
		if fn() {
			return C.bool(true)
		} else {
			return C.bool(false)
		}
	}
	return true
}

func (t WhisperTokenData) T0() int64 {
	return int64(t.t0)
}

func (t WhisperTokenData) T1() int64 {
	return int64(t.t1)
}

func (t WhisperTokenData) Id() WhisperToken {
	return WhisperToken(t.id)
}

///////////////////////////////////////////////////////////////////////////////
// PARAMS METHODS (Merged from params.go)

func (p *WhisperParams) SetTranslate(v bool) {
	p.translate = toBool(v)
}

func (p *WhisperParams) SetSplitOnWord(v bool) {
	p.split_on_word = toBool(v)
}

func (p *WhisperParams) SetNoContext(v bool) {
	p.no_context = toBool(v)
}

func (p *WhisperParams) SetSingleSegment(v bool) {
	p.single_segment = toBool(v)
}

func (p *WhisperParams) SetPrintSpecial(v bool) {
	p.print_special = toBool(v)
}

func (p *WhisperParams) SetPrintProgress(v bool) {
	p.print_progress = toBool(v)
}

func (p *WhisperParams) SetPrintRealtime(v bool) {
	p.print_realtime = toBool(v)
}

func (p *WhisperParams) SetPrintTimestamps(v bool) {
	p.print_timestamps = toBool(v)
}

// Set language id
func (p *WhisperParams) SetLanguage(lang int) error {
	if lang == -1 {
		p.language = nil
		return nil
	}
	str := C.whisper_lang_str(C.int(lang))
	if str == nil {
		return ErrInvalidLanguage
	} else {
		p.language = str
	}
	return nil
}

// Get language id
func (p *WhisperParams) Language() int {
	if p.language == nil {
		return -1
	}
	return int(C.whisper_lang_id(p.language))
}

// Threads available
func (p *WhisperParams) Threads() int {
	return int(p.n_threads)
}

// Set number of threads to use
func (p *WhisperParams) SetThreads(threads int) {
	p.n_threads = C.int(threads)
}

// Set start offset in ms
func (p *WhisperParams) SetOffset(offset_ms int) {
	p.offset_ms = C.int(offset_ms)
}

// Set audio duration to process in ms
func (p *WhisperParams) SetDuration(duration_ms int) {
	p.duration_ms = C.int(duration_ms)
}

// Set timestamp token probability threshold (~0.01)
func (p *WhisperParams) SetTokenThreshold(t float32) {
	p.thold_pt = C.float(t)
}

// Set timestamp token sum probability threshold (~0.01)
func (p *WhisperParams) SetTokenSumThreshold(t float32) {
	p.thold_ptsum = C.float(t)
}

// Set max segment length in characters
func (p *WhisperParams) SetMaxSegmentLength(n int) {
	p.max_len = C.int(n)
}

func (p *WhisperParams) SetTokenTimestamps(b bool) {
	p.token_timestamps = toBool(b)
}

// Set max tokens per segment (0 = no limit)
func (p *WhisperParams) SetMaxTokensPerSegment(n int) {
	p.max_tokens = C.int(n)
}

// Set audio encoder context
func (p *WhisperParams) SetAudioCtx(n int) {
	p.audio_ctx = C.int(n)
}

func (p *WhisperParams) SetMaxContext(n int) {
	p.n_max_text_ctx = C.int(n)
}

func (p *WhisperParams) SetBeamSize(n int) {
	p.beam_search.beam_size = C.int(n)
}

func (p *WhisperParams) SetEntropyThold(t float32) {
	p.entropy_thold = C.float(t)
}

func (p *WhisperParams) SetTemperature(t float32) {
	p.temperature = C.float(t)
}

// Sets the fallback temperature incrementation
// Pass -1.0 to disable this feature
func (p *WhisperParams) SetTemperatureFallback(t float32) {
	p.temperature_inc = C.float(t)
}

// Set initial prompt
func (p *WhisperParams) SetInitialPrompt(prompt string) {
	p.initial_prompt = C.CString(prompt)
}

func (p *WhisperParams) SetCarryInitialPrompt(v bool) {
	p.carry_initial_prompt = toBool(v)
}

// SetDiarize enables tinydiarize speaker turn detection
// This works best with stereo audio where left channel = speaker 1, right channel = speaker 2
func (p *WhisperParams) SetDiarize(v bool) {
	p.tdrz_enable = toBool(v)
}

///////////////////////////////////////////////////////////////////////////////
// PRIVATE METHODS

func toBool(v bool) C.bool {
	if v {
		return C.bool(true)
	}
	return C.bool(false)
}

type executionTarget struct {
	kind      string
	useGPU    bool
	gpuDevice int
}

func detectExecutionTarget() executionTarget {
	// Allow override via env WHISPER_DEVICE: cpu|gpu|auto|apple
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WHISPER_DEVICE"))) {
	case "cpu":
		return executionTarget{kind: "cpu", useGPU: false}
	case "gpu", "cuda":
		return executionTarget{kind: "gpu", useGPU: true}
	case "apple", "apple-silicon", "metal":
		return executionTarget{kind: "apple-silicon", useGPU: true}
	}

	// Apple Silicon -> prefer Metal backend
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" {
		// Check if ggml-metal.metal exists in current directory or executable directory
		if hasMetalShader() {
			return executionTarget{kind: "apple-silicon", useGPU: true}
		}
		log.Println("Warning: ggml-metal.metal not found, falling back to CPU")
	}

	// Simple heuristic for NVIDIA GPU presence
	if hasNvidiaGPU() {
		return executionTarget{kind: "gpu", useGPU: true}
	}

	return executionTarget{kind: "cpu", useGPU: false}
}

func hasMetalShader() bool {
	// Check current directory
	if _, err := os.Stat("ggml-metal.metal"); err == nil {
		return true
	}
	// Check executable directory
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, "ggml-metal.metal")); err == nil {
			return true
		}
	}
	return false
}

func hasNvidiaGPU() bool {
	if _, err := os.Stat("/dev/nvidia0"); err == nil {
		return true
	}
	env := strings.ToLower(strings.TrimSpace(os.Getenv("NVIDIA_VISIBLE_DEVICES")))
	if env != "" && env != "none" {
		return true
	}
	env = strings.ToLower(strings.TrimSpace(os.Getenv("CUDA_VISIBLE_DEVICES")))
	return env != "" && env != "none"
}

///////////////////////////////////////////////////////////////////////////////
// STRINGIFY

func (p *WhisperParams) String() string {
	str := "<whisper.params"
	str += fmt.Sprintf(" strategy=%v", p.strategy)
	str += fmt.Sprintf(" n_threads=%d", p.n_threads)
	if p.language != nil {
		str += fmt.Sprintf(" language=%s", C.GoString(p.language))
	}
	str += fmt.Sprintf(" n_max_text_ctx=%d", p.n_max_text_ctx)
	str += fmt.Sprintf(" offset_ms=%d", p.offset_ms)
	str += fmt.Sprintf(" duration_ms=%d", p.duration_ms)
	str += fmt.Sprintf(" audio_ctx=%d", p.audio_ctx)
	str += fmt.Sprintf(" initial_prompt=%s", C.GoString(p.initial_prompt))
	str += fmt.Sprintf(" entropy_thold=%f", p.entropy_thold)
	str += fmt.Sprintf(" temperature=%f", p.temperature)
	str += fmt.Sprintf(" temperature_inc=%f", p.temperature_inc)
	str += fmt.Sprintf(" beam_size=%d", p.beam_search.beam_size)
	if p.translate {
		str += " translate"
	}
	if p.no_context {
		str += " no_context"
	}
	if p.single_segment {
		str += " single_segment"
	}
	if p.print_special {
		str += " print_special"
	}
	if p.print_progress {
		str += " print_progress"
	}
	if p.print_realtime {
		str += " print_realtime"
	}
	if p.print_timestamps {
		str += " print_timestamps"
	}
	if p.token_timestamps {
		str += " token_timestamps"
	}
	if p.carry_initial_prompt {
		str += " carry_initial_prompt"
	}

	return str + ">"
}
