"""16-bit mono PCM to QQ's SILK voice format (Tencent variant), so NapCat sends it as is.

Usage: silk.py <in.pcm> <out.silk> <sample rate>. Runs in the voice venv (scripts/setup-voice.sh) that has pilk.
"""
import sys
import pilk

source, target, rate = sys.argv[1], sys.argv[2], int(sys.argv[3])
duration = pilk.encode(source, target, pcm_rate=rate, tencent=True)
print(duration)
