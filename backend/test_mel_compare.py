#!/usr/bin/env python3
"""
Сравнение mel-спектрограммы: Go vs PyTorch (torchaudio)
Для отладки GigaAM v3
"""

import numpy as np
import torch
import torchaudio
import subprocess
import struct
import sys

# GigaAM v3 параметры
SAMPLE_RATE = 16000
N_MELS = 64
HOP_LENGTH = 160
WIN_LENGTH = 320
N_FFT = 320
CENTER = False  # GigaAM v3 использует center=False


def load_audio_ffmpeg(path: str) -> np.ndarray:
    """Загрузка аудио через ffmpeg (как в GigaAM)"""
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
    if result.returncode != 0:
        print(f"ffmpeg error: {result.stderr.decode()}")
    audio = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def load_audio_torchaudio(path: str) -> np.ndarray:
    """Загрузка аудио через torchaudio"""
    wav, sr = torchaudio.load(path)
    if sr != SAMPLE_RATE:
        resampler = torchaudio.transforms.Resample(sr, SAMPLE_RATE)
        wav = resampler(wav)
    # mono
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    return wav.squeeze(0).numpy()


def compute_mel_torchaudio(audio: np.ndarray) -> np.ndarray:
    """Вычисление mel-спектрограммы через torchaudio (эталон)"""
    wav = torch.from_numpy(audio).unsqueeze(0)

    mel_transform = torchaudio.transforms.MelSpectrogram(
        sample_rate=SAMPLE_RATE,
        n_mels=N_MELS,
        n_fft=N_FFT,
        win_length=WIN_LENGTH,
        hop_length=HOP_LENGTH,
        center=CENTER,
        mel_scale="htk",  # GigaAM v3 использует HTK
        norm=None,  # mel_norm: null
    )

    mel = mel_transform(wav)
    # Применяем log с клампингом как в GigaAM
    mel = torch.log(mel.clamp(min=1e-9))

    return mel.squeeze(0).numpy()  # [n_mels, time]


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_mel_compare.py <audio_file>")
        sys.exit(1)

    audio_path = sys.argv[1]
    print(f"Loading audio: {audio_path}")

    # Сначала пробуем torchaudio, потом ffmpeg
    try:
        audio = load_audio_torchaudio(audio_path)
        print("Loaded via torchaudio")
    except Exception as e:
        print(f"torchaudio failed: {e}, trying ffmpeg")
        audio = load_audio_ffmpeg(audio_path)
    print(f"Audio length: {len(audio)} samples ({len(audio) / SAMPLE_RATE:.2f}s)")

    # Вычисляем mel через torchaudio
    mel = compute_mel_torchaudio(audio)
    print(f"Mel shape: {mel.shape} (n_mels={mel.shape[0]}, frames={mel.shape[1]})")

    # Выводим статистику
    print(f"\nMel statistics:")
    print(f"  Min: {mel.min():.4f}")
    print(f"  Max: {mel.max():.4f}")
    print(f"  Mean: {mel.mean():.4f}")
    print(f"  Std: {mel.std():.4f}")

    # Выводим первые несколько фреймов для сравнения
    print(f"\nFirst 3 frames (first 10 mel bins):")
    for frame_idx in range(min(3, mel.shape[1])):
        vals = mel[:10, frame_idx]
        print(f"  Frame {frame_idx}: {vals}")

    # Сохраняем в файл для сравнения с Go
    np.save("/tmp/mel_reference.npy", mel)
    print(f"\nReference mel saved to /tmp/mel_reference.npy")

    # Также выведем raw audio samples для Go
    print(f"\nFirst 10 audio samples:")
    print(f"  {audio[:10]}")


if __name__ == "__main__":
    main()
