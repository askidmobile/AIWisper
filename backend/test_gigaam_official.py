#!/usr/bin/env python3
"""
Тестирование GigaAM v3 ONNX напрямую для сравнения с Go реализацией
"""

import sys
import os
import subprocess
import numpy as np

# Параметры GigaAM v3
SAMPLE_RATE = 16000
N_MELS = 64
HOP_LENGTH = 160
WIN_LENGTH = 320
N_FFT = 320
CENTER = False

# Словарь v3_ctc (34 токена)
VOCAB = [
    " ",
    "а",
    "б",
    "в",
    "г",
    "д",
    "е",
    "ж",
    "з",
    "и",
    "й",
    "к",
    "л",
    "м",
    "н",
    "о",
    "п",
    "р",
    "с",
    "т",
    "у",
    "ф",
    "х",
    "ц",
    "ч",
    "ш",
    "щ",
    "ъ",
    "ы",
    "ь",
    "э",
    "ю",
    "я",
]
BLANK_ID = 33


def load_audio_ffmpeg(path: str) -> np.ndarray:
    """Загрузка аудио через ffmpeg"""
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-threads",
        "0",
        "-i",
        path,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(SAMPLE_RATE),
        "-",
    ]
    result = subprocess.run(cmd, capture_output=True)
    audio = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def compute_mel_spectrogram(audio: np.ndarray) -> np.ndarray:
    """Вычисление mel-спектрограммы (как в GigaAM)"""
    import torch
    import torchaudio

    wav = torch.from_numpy(audio).unsqueeze(0)
    mel_transform = torchaudio.transforms.MelSpectrogram(
        sample_rate=SAMPLE_RATE,
        n_mels=N_MELS,
        n_fft=N_FFT,
        win_length=WIN_LENGTH,
        hop_length=HOP_LENGTH,
        center=CENTER,
        mel_scale="htk",
        norm=None,
    )
    mel = mel_transform(wav)
    mel = torch.log(mel.clamp(min=1e-9))
    return mel.numpy()  # [1, n_mels, time]


def ctc_decode(logits: np.ndarray) -> str:
    """CTC greedy decoding"""
    # logits shape: [1, time, vocab_size]
    tokens = np.argmax(logits[0], axis=-1)  # [time]

    # CTC: удаляем blank и повторы
    result = []
    prev_token = BLANK_ID
    for token in tokens:
        if token != BLANK_ID and token != prev_token:
            if token < len(VOCAB):
                result.append(VOCAB[token])
        prev_token = token

    return "".join(result)


def main():
    model_path = (
        "/Users/askid/Library/Application Support/aiwisper/models/gigaam-v3-ctc.onnx"
    )
    audio_path = "/Users/askid/Library/Application Support/aiwisper/sessions/5f581ceb-3cda-4f16-bb76-e19fe9c642e7/full.mp3"

    if len(sys.argv) > 1:
        audio_path = sys.argv[1]

    print(f"Model: {model_path}")
    print(f"Audio: {audio_path}")

    # Загружаем аудио
    print("\nLoading audio...")
    audio = load_audio_ffmpeg(audio_path)
    print(f"Audio length: {len(audio)} samples ({len(audio) / SAMPLE_RATE:.2f}s)")
    print(
        f"Audio stats: min={audio.min():.6f}, max={audio.max():.6f}, mean={audio.mean():.6f}, std={audio.std():.6f}"
    )

    # Вычисляем mel-спектрограмму
    print("\nComputing mel spectrogram...")
    mel = compute_mel_spectrogram(audio)
    print(f"Mel shape: {mel.shape}")
    print(f"Mel stats: min={mel.min():.4f}, max={mel.max():.4f}, mean={mel.mean():.4f}")

    # Сохраняем mel для сравнения с Go
    np.save("/tmp/mel_python.npy", mel)
    print("Saved mel to /tmp/mel_python.npy")

    # Загружаем ONNX модель
    print("\nLoading ONNX model...")
    import onnxruntime as ort

    sess = ort.InferenceSession(model_path)

    # Получаем информацию о входах/выходах
    print("Inputs:")
    for inp in sess.get_inputs():
        print(f"  {inp.name}: {inp.shape} ({inp.type})")
    print("Outputs:")
    for out in sess.get_outputs():
        print(f"  {out.name}: {out.shape} ({out.type})")

    # Подготовим только первые 25 секунд (максимум для GigaAM)
    max_samples = 25 * SAMPLE_RATE
    if len(audio) > max_samples:
        print(f"\nTruncating to 25 seconds for testing...")
        audio = audio[:max_samples]
        mel = compute_mel_spectrogram(audio)
        print(f"New mel shape: {mel.shape}")

    # Инференс
    print("\nRunning inference...")
    feature_lengths = np.array([mel.shape[2]], dtype=np.int64)

    outputs = sess.run(
        None, {"features": mel.astype(np.float32), "feature_lengths": feature_lengths}
    )

    logits = outputs[0]
    print(f"Logits shape: {logits.shape}")

    # CTC декодирование
    print("\nDecoding...")
    result = ctc_decode(logits)
    print(f"\n=== RESULT ===\n{result}\n==============")


if __name__ == "__main__":
    main()
