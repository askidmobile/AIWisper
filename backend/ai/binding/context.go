package whisper

import (
	"fmt"
	"io"
	"runtime"
	"strings"
	"time"
)

///////////////////////////////////////////////////////////////////////////////
// TYPES

type context struct {
	n      int
	model  *model
	params WhisperParams
}

// Make sure context adheres to the interface
var _ Context = (*context)(nil)

///////////////////////////////////////////////////////////////////////////////
// LIFECYCLE

func newContext(model *model, params WhisperParams) (Context, error) {
	context := new(context)
	context.model = model
	context.params = params

	// Return success
	return context, nil
}

///////////////////////////////////////////////////////////////////////////////
// PUBLIC METHODS

// Set the language to use for speech recognition.
func (context *context) SetLanguage(lang string) error {
	if context.model.ctx == nil {
		return ErrInternalAppError
	}
	if !context.model.IsMultilingual() {
		return ErrModelNotMultilingual
	}
	if lang == "auto" {
		context.params.SetLanguage(-1)
	} else if id := context.model.ctx.Whisper_lang_id(lang); id == -1 {
		return ErrInvalidLanguage
	} else {
		context.params.SetLanguage(id)
	}
	return nil
}

// Set the offset of the audio to start processing.
func (context *context) SetOffset(offset time.Duration) {
	context.params.SetOffset(int(offset.Milliseconds()))
}

// Set the duration of the audio to process.
func (context *context) SetDuration(duration time.Duration) {
	context.params.SetDuration(int(duration.Milliseconds()))
}

// Set the number of threads to use for processing.
func (context *context) SetThreads(threads uint) {
	context.params.SetThreads(int(threads))
}

// Set translate to true to translate the audio to English.
func (context *context) SetTranslate(translate bool) {
	context.params.SetTranslate(translate)
}

// Process the audio and return the text.
func (context *context) Process(samples []float32, encoderBeginCallback EncoderBeginCallback, newSegmentCallback SegmentCallback, progressCallback ProgressCallback) error {
	if context.model.ctx == nil {
		return ErrInternalAppError
	}

	// Reset segment cursor for each new processing run so NextSegment starts from the first result.
	context.n = 0

	// Run full
	cb := func(nNew int) {
		if newSegmentCallback != nil {
			nSegments := context.model.ctx.Whisper_full_n_segments()
			start := nSegments - nNew
			for i := start; i < nSegments; i++ {
				newSegmentCallback(toSegment(context.model.ctx, i))
			}
		}
	}
	if err := context.model.ctx.Whisper_full(context.params, samples, encoderBeginCallback, cb, progressCallback); err != nil {
		return err
	}

	// Return success
	return nil
}

// Return the text of the processed audio.
// Process() must be called first.
func (context *context) Text() string {
	if context.model.ctx == nil {
		return ""
	}

	// Get number of segments
	n := context.model.ctx.Whisper_full_n_segments()
	str := make([]string, n)
	for i := 0; i < n; i++ {
		str[i] = context.model.ctx.Whisper_full_get_segment_text(i)
	}

	// Return text
	return strings.Join(str, "")
}

// Return the segments of the processed audio.
// Process() must be called first.
func (context *context) Segments() []Segment {
	if context.model.ctx == nil {
		return nil
	}

	// Get number of segments
	n := context.model.ctx.Whisper_full_n_segments()
	segments := make([]Segment, n)
	for i := 0; i < n; i++ {
		segments[i] = toSegment(context.model.ctx, i)
	}

	// Return segments
	return segments
}

// Return all tokens from all segments of the processed audio.
// Process() must be called first.
func (context *context) Tokens() []Token {
	if context.model.ctx == nil {
		return nil
	}

	var allTokens []Token
	n := context.model.ctx.Whisper_full_n_segments()
	for i := 0; i < n; i++ {
		tokens := toTokens(context.model.ctx, i)
		allTokens = append(allTokens, tokens...)
	}

	return allTokens
}

///////////////////////////////////////////////////////////////////////////////
// STRINGIFY

func (context *context) String() string {
	str := "<whisper.context"
	str += fmt.Sprintf(" model=%v", context.model)
	str += fmt.Sprintf(" params=%v", context.params)
	return str + ">"
}

func (context *context) IsMultilingual() bool {
	return context.model.IsMultilingual()
}

// Get language
func (context *context) Language() string {
	id := context.params.Language()
	if id == -1 {
		return "auto"
	}
	return Whisper_lang_str(context.params.Language())
}

func (context *context) DetectedLanguage() string {
	return Whisper_lang_str(context.model.ctx.Whisper_full_lang_id())
}

func (context *context) SetSplitOnWord(v bool) {
	context.params.SetSplitOnWord(v)
}

// Set timestamp token probability threshold (~0.01)
func (context *context) SetTokenThreshold(t float32) {
	context.params.SetTokenThreshold(t)
}

// Set timestamp token sum probability threshold (~0.01)
func (context *context) SetTokenSumThreshold(t float32) {
	context.params.SetTokenSumThreshold(t)
}

// Set max segment length in characters
func (context *context) SetMaxSegmentLength(n uint) {
	context.params.SetMaxSegmentLength(int(n))
}

// Set token timestamps flag
func (context *context) SetTokenTimestamps(b bool) {
	context.params.SetTokenTimestamps(b)
}

// Set max tokens per segment (0 = no limit)
func (context *context) SetMaxTokensPerSegment(n uint) {
	context.params.SetMaxTokensPerSegment(int(n))
}

// Set audio encoder context
func (context *context) SetAudioCtx(n uint) {
	context.params.SetAudioCtx(int(n))
}

// Set maximum number of text context tokens to store
func (context *context) SetMaxContext(n int) {
	context.params.SetMaxContext(n)
}

// Set Beam Size
func (context *context) SetBeamSize(n int) {
	context.params.SetBeamSize(n)
}

// Set Entropy threshold
func (context *context) SetEntropyThold(t float32) {
	context.params.SetEntropyThold(t)
}

// Set Temperature
func (context *context) SetTemperature(t float32) {
	context.params.SetTemperature(t)
}

// Set the fallback temperature incrementation
// Pass -1.0 to disable this feature
func (context *context) SetTemperatureFallback(t float32) {
	context.params.SetTemperatureFallback(t)
}

// Set initial prompt
func (context *context) SetInitialPrompt(prompt string) {
	context.params.SetInitialPrompt(prompt)
}

// SetDiarize enables tinydiarize speaker turn detection
func (context *context) SetDiarize(v bool) {
	context.params.SetDiarize(v)
}

// ResetTimings resets the mode timings. Should be called before processing
func (context *context) ResetTimings() {
	context.model.ctx.Whisper_reset_timings()
}

// PrintTimings prints the model timings to stdout.
func (context *context) PrintTimings() {
	context.model.ctx.Whisper_print_timings()
}

// SystemInfo returns the system information
func (context *context) SystemInfo() string {
	return fmt.Sprintf("system_info: n_threads = %d / %d | %s\n",
		context.params.Threads(),
		runtime.NumCPU(),
		Whisper_print_system_info(),
	)
}

// Use mel data at offset_ms to try and auto-detect the spoken language
// Make sure to call whisper_pcm_to_mel() or whisper_set_mel() first.
// Returns the probabilities of all languages.
func (context *context) WhisperLangAutoDetect(offset_ms int, n_threads int) ([]float32, error) {
	langProbs, err := context.model.ctx.Whisper_lang_auto_detect(offset_ms, n_threads)
	if err != nil {
		return nil, err
	}
	return langProbs, nil
}

// Return the next segment of tokens
func (context *context) NextSegment() (Segment, error) {
	if context.model.ctx == nil {
		return Segment{}, ErrInternalAppError
	}
	if context.n >= context.model.ctx.Whisper_full_n_segments() {
		return Segment{}, io.EOF
	}

	// Populate result
	result := toSegment(context.model.ctx, context.n)

	// Increment the cursor
	context.n++

	// Return success
	return result, nil
}

// Test for text tokens
func (context *context) IsText(t Token) bool {
	switch {
	case context.IsBEG(t):
		return false
	case context.IsSOT(t):
		return false
	case WhisperToken(t.Id) >= context.model.ctx.Whisper_token_eot():
		return false
	case context.IsPREV(t):
		return false
	case context.IsSOLM(t):
		return false
	case context.IsNOT(t):
		return false
	default:
		return true
	}
}

// Test for "begin" token
func (context *context) IsBEG(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_beg()
}

// Test for "start of transcription" token
func (context *context) IsSOT(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_sot()
}

// Test for "end of transcription" token
func (context *context) IsEOT(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_eot()
}

// Test for "start of prev" token
func (context *context) IsPREV(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_prev()
}

// Test for "start of lm" token
func (context *context) IsSOLM(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_solm()
}

// Test for "No timestamps" token
func (context *context) IsNOT(t Token) bool {
	return WhisperToken(t.Id) == context.model.ctx.Whisper_token_not()
}

// Test for token associated with a specific language
func (context *context) IsLANG(t Token, lang string) bool {
	if id := context.model.ctx.Whisper_lang_id(lang); id >= 0 {
		return WhisperToken(t.Id) == context.model.ctx.Whisper_token_lang(id)
	} else {
		return false
	}
}

///////////////////////////////////////////////////////////////////////////////
// PRIVATE METHODS

func toSegment(ctx *WhisperContext, n int) Segment {
	return Segment{
		Num:    n,
		Text:   strings.TrimSpace(ctx.Whisper_full_get_segment_text(n)),
		Start:  time.Duration(ctx.Whisper_full_get_segment_t0(n)) * time.Millisecond * 10,
		End:    time.Duration(ctx.Whisper_full_get_segment_t1(n)) * time.Millisecond * 10,
		Tokens: toTokens(ctx, n),
	}
}

func toTokens(ctx *WhisperContext, n int) []Token {
	result := make([]Token, ctx.Whisper_full_n_tokens(n))
	for i := 0; i < len(result); i++ {
		data := ctx.Whisper_full_get_token_data(n, i)

		result[i] = Token{
			Id:    int(ctx.Whisper_full_get_token_id(n, i)),
			Text:  ctx.Whisper_full_get_token_text(n, i),
			P:     ctx.Whisper_full_get_token_p(n, i),
			Start: time.Duration(data.T0()) * time.Millisecond * 10,
			End:   time.Duration(data.T1()) * time.Millisecond * 10,
		}
	}
	return result
}
