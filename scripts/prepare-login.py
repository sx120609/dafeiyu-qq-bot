import json
import pathlib
import urllib.parse
import time
from supervisor import CONFIG, RUNTIME, NapCat

# NapCat's own WebUI supports a token query for local auto-login.
token=json.loads((CONFIG/'webui.json').read_text())['token']
url='http://127.0.0.1:6099/webui/?token='+urllib.parse.quote(token,safe='')
(RUNTIME/'qq-login-url.txt').write_text(url)
client=NapCat(timeout=5)
deadline=time.monotonic()+60
for attempt in range(30):
    try:
        status=client.call('QQLogin/CheckLoginStatus')
        break
    except (OSError, KeyError, ValueError, RuntimeError):
        if attempt == 29 or time.monotonic()>=deadline:
            raise RuntimeError('QQ runtime is not ready yet; run Status.cmd and retry shortly')
        time.sleep(2)
print('QQ already logged in.' if status.get('isLogin') else 'QQ login page ready.')
