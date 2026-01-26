#!/usr/bin/env python3
"""
Тестирование GigaAM v3 E2E (с пунктуацией) через ONNX
"""

import sys
import subprocess
import numpy as np

# Параметры GigaAM v3 E2E (те же что и CTC)
SAMPLE_RATE = 16000
N_MELS = 64
HOP_LENGTH = 160
WIN_LENGTH = 320
N_FFT = 320
CENTER = False


def load_vocab(path: str) -> list:
    """Загрузка словаря"""
    vocab = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.strip().split(" ")
            if parts:
                # Первая часть - токен, последняя - индекс
                # Для токена пробела строка начинается с пробела
                if line.startswith(" "):
                    token = " "
                else:
                    token = parts[0]
                vocab.append(token)
    return vocab


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
    """Вычисление mel-спектрограммы"""
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
    return mel.numpy()


def ctc_decode_e2e(logits: np.ndarray, vocab: list) -> str:
    """CTC greedy decoding для E2E модели"""
    blank_id = len(vocab) - 1  # <blk> последний
    tokens = np.argmax(logits[0], axis=-1)

    # CTC: удаляем blank и повторы
    result = []
    prev_token = blank_id
    for token in tokens:
        if token != blank_id and token != prev_token:
            if token < len(vocab):
                result.append(vocab[token])
        prev_token = token

    # Объединяем токены и обрабатываем ▁
    text = "".join(result)
    text = text.replace("▁", " ")
    text = text.strip()

    return text


def main():
    model_path = "/Users/askid/Library/Application Support/aiwisper/models/gigaam-v3-e2e-ctc.onnx"
    vocab_path = "/Users/askid/Library/Application Support/aiwisper/models/gigaam-v3-e2e-ctc_vocab.txt"
    audio_path = "/Users/askid/Library/Application Support/aiwisper/sessions/5f581ceb-3cda-4f16-bb76-e19fe9c642e7/full.mp3"

    if len(sys.argv) > 1:
        audio_path = sys.argv[1]

    print(f"Model: {model_path}")
    print(f"Vocab: {vocab_path}")
    print(f"Audio: {audio_path}")

    # Загружаем словарь
    vocab = load_vocab(vocab_path)
    print(f"\nVocab size: {len(vocab)}")
    print(f"First 10 tokens: {vocab[:10]}")
    print(f"Last 5 tokens: {vocab[-5:]}")

    # Загружаем аудио
    print("\nLoading audio...")
    audio = load_audio_ffmpeg(audio_path)
    print(f"Audio length: {len(audio)} samples ({len(audio) / SAMPLE_RATE:.2f}s)")

    # Вычисляем mel-спектрограмму
    print("\nComputing mel spectrogram...")
    mel = compute_mel_spectrogram(audio)
    print(f"Mel shape: {mel.shape}")

    # Загружаем ONNX модель
    print("\nLoading ONNX model...")
    import onnxruntime as ort

    sess = ort.InferenceSession(model_path)

    print("Inputs:")
    for inp in sess.get_inputs():
        print(f"  {inp.name}: {inp.shape} ({inp.type})")
    print("Outputs:")
    for out in sess.get_outputs():
        print(f"  {out.name}: {out.shape} ({out.type})")

    # Ограничиваем 25 секундами
    max_samples = 25 * SAMPLE_RATE
    if len(audio) > max_samples:
        print(f"\nTruncating to 25 seconds...")
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
    result = ctc_decode_e2e(logits, vocab)
    print(
        f"\n=== RESULT (E2E with punctuation) ===\n{result}\n====================================="
    )


if __name__ == "__main__":
    main()
