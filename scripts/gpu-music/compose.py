"""One song on the GPU server for the bot's compose_music tool (bridge/music.mjs runs it over SSH).

Reads {"prompt", "lyrics", "duration", "seed"} as JSON on stdin, writes an MP3 next to this file and prints one JSON
line: {"file", "seconds", "took"} or {"error"}. MiniMax Music 3 through diffusers; the model directory and Python
environment are the ones already on the server (MUSIC_MODEL_DIR). Lyrics may carry section tags ([Verse], [Chorus],
...); none means an instrumental piece.
"""
import json, os, subprocess, sys, time, uuid

def done(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)
    sys.exit(0)

job = json.load(sys.stdin)
prompt = str(job.get('prompt') or '').strip()
lyrics = str(job.get('lyrics') or '').strip() or '[Instrumental]'
duration = max(10.0, min(300.0, float(job.get('duration') or 60)))
if not prompt:
    done(error='缺少音乐描述')

import torch
# The GPU is shared: say so instead of failing halfway when someone else holds most of it.
free, total = torch.cuda.mem_get_info()
if free < 23 * 2**30:
    done(error=f'5090 的显存正被别的任务占着（只剩 {free / 2**30:.0f} GB，要 23 GB），等会儿再试')

import soundfile as sf
from diffusers import ModularPipeline
started = time.time()
pipe = ModularPipeline.from_pretrained(os.environ['MUSIC_MODEL_DIR'])
pipe.load_components(dtype=torch.bfloat16)
pipe.to('cuda')
seed = int(job.get('seed') or int.from_bytes(os.urandom(4), 'little'))
audio = pipe(prompt=prompt, lyrics=lyrics, audio_duration=duration,
             generator=torch.Generator('cuda').manual_seed(seed), output='audios')[0]
data = audio.float().cpu().numpy() if hasattr(audio, 'cpu') else audio
data = data.T if data.shape[0] in (1, 2) else data
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(out, exist_ok=True)
name = os.path.join(out, uuid.uuid4().hex)
sf.write(name + '.wav', data, pipe.sampling_rate)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', name + '.wav', '-codec:a', 'libmp3lame', '-b:a', '192k', name + '.mp3'], check=True)
os.remove(name + '.wav')
done(file=name + '.mp3', seconds=round(data.shape[0] / pipe.sampling_rate, 1), took=round(time.time() - started, 1), seed=seed)
