#!/usr/bin/env python3
"""
CLI wrapper for faster-whisper with optimized parameters for quality.

Оптимизации для улучшения качества распознавания:
- temperature=0.0: детерминированный вывод, меньше галлюцинаций
- condition_on_previous_text=False: предотвращает зацикливание
- hallucination_silence_threshold: отбрасывает сегменты с длинными паузами
- Silero VAD с оптимальными параметрами
"""

import argparse
import sys

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser(description="CLI wrapper for faster-whisper")
    parser.add_argument(
        "--model", required=True, help="Path to faster-whisper model directory"
    )
    parser.add_argument("--file", required=True, help="Path to WAV (16k mono)")
    parser.add_argument(
        "--language", default="auto", help="Language code, e.g. ru/en/auto"
    )
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--best-of", type=int, default=5)
    parser.add_argument(
        "--task", default="transcribe", choices=["transcribe", "translate"]
    )
    args = parser.parse_args()

    model = WhisperModel(
        args.model,
        device="auto",
        compute_type="auto",
    )

    # Оптимальные параметры Silero VAD для качественного распознавания
    vad_parameters = {
        "threshold": 0.5,  # Порог детекции речи (0.0-1.0)
        "min_speech_duration_ms": 250,  # Мин. длительность речи для детекции
        "min_silence_duration_ms": 2000,  # Мин. пауза для разделения сегментов
        "window_size_samples": 1024,  # Размер окна анализа
        "speech_pad_ms": 400,  # Padding вокруг речи
    }

    segments, _ = model.transcribe(
        args.file,
        beam_size=args.beam_size,
        best_of=args.best_of,
        language=None if args.language == "auto" else args.language,
        task=args.task,
        # === Параметры против галлюцинаций ===
        # Детерминированный вывод - меньше случайности, стабильнее результат
        temperature=0.0,
        # Не использовать контекст предыдущих сегментов
        # Предотвращает зацикливание и накопление ошибок
        condition_on_previous_text=False,
        # Порог для определения "тишины" (вероятность no_speech)
        # Сегменты с вероятностью тишины выше порога отбрасываются
        no_speech_threshold=0.5,
        # Отбрасывать сегменты где между словами > 2 сек тишины
        # Эффективно против галлюцинаций на пустом аудио
        hallucination_silence_threshold=2.0,
        # === Silero VAD ===
        vad_filter=True,
        vad_parameters=vad_parameters,
        # Word-level timestamps (нужно для hallucination_silence_threshold)
        word_timestamps=True,
    )

    text_parts = [seg.text.strip() for seg in segments]
    print(" ".join(tp for tp in text_parts if tp))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"error: {e}\n")
        sys.exit(1)
