#!/usr/bin/env python3
import argparse
import sys

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description="CLI wrapper for faster-whisper")
    parser.add_argument("--model", required=True, help="Path to faster-whisper model directory")
    parser.add_argument("--file", required=True, help="Path to WAV (16k mono)")
    parser.add_argument("--language", default="auto", help="Language code, e.g. ru/en/auto")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--best-of", type=int, default=5)
    parser.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    args = parser.parse_args()

    model = WhisperModel(
        args.model,
        device="auto",
        compute_type="auto",
    )

    segments, _ = model.transcribe(
        args.file,
        beam_size=args.beam_size,
        best_of=args.best_of,
        language=None if args.language == "auto" else args.language,
        task=args.task,
        vad_filter=True,
    )

    text_parts = [seg.text.strip() for seg in segments]
    print(" ".join(tp for tp in text_parts if tp))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"error: {e}\n")
        sys.exit(1)
