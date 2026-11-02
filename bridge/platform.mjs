// Programs the gateway runs that live in different places on Windows and in WSL.
export const windows=process.platform==='win32';
/** ffmpeg for video frames and MP3 decoding: DAFEIYU_FFMPEG (bridge.json "ffmpeg"), else the one on PATH. */
export const ffmpeg=()=>process.env.DAFEIYU_FFMPEG||(windows?'ffmpeg':'/usr/bin/ffmpeg');
export const cmd=windows?(process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe'):'/mnt/c/Windows/System32/cmd.exe';
export const reg=windows?'reg.exe':'/mnt/c/Windows/System32/reg.exe';
