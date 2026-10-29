"""Import a folder of stickers (images plus manifest.json) into the running engine's sticker library.

Usage (WSL): python3 scripts/import-stickers.py stickers/generated [stickers/web ...]
manifest.json is a list of {file, title, emotion, context, source?, author?}. Replies keep running
while importing. Images already in the library are skipped.
"""
import base64, json, pathlib, sys, urllib.error
from supervisor import Panel, RUNTIME, request

panel = Panel((RUNTIME/'control-url.txt').read_text())
emotions = {'neutral', 'joy', 'smug', 'annoyed', 'sad', 'sleepy', 'flustered', 'teasing'}
added, skipped = 0, []
for folder in map(pathlib.Path, sys.argv[1:]):
    for item in json.loads((folder/'manifest.json').read_text(encoding='utf-8')):
        image = folder/item['file']
        if item.get('emotion') not in emotions or not image.is_file():
            skipped.append(f"{item.get('file')}: 情绪或文件无效"); continue
        sticker = {'title': item['title'][:80], 'emotion': item['emotion'], 'context': item.get('context', '')[:300],
                   # Only a clean public https page is accepted as a source; anything else stays blank.
                   'source': item['source'] if str(item.get('source', '')).startswith('https://') and not set('?#@') & set(item['source']) else '',
                   'author': item.get('author', '')[:80], 'license': '', 'publicSharing': False}
        status = panel.status()
        try:
            result = request(panel.base+'/api/import-sticker', {'action': 'importSticker', 'configurationRevision': status['configurationRevision'],
                             'sticker': sticker, 'stickerImage': base64.b64encode(image.read_bytes()).decode()}, panel.headers, timeout=60)
        except urllib.error.HTTPError as e:
            skipped.append(f"{item['file']}: HTTP {e.code}"); continue
        if result.get('error'): skipped.append(f"{item['file']}: {result['error']}")
        else: added += 1
print(f'imported {added}, skipped {len(skipped)}')
for line in skipped: print('  ' + line)
