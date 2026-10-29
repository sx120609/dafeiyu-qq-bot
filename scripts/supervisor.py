"""Local deployment supervisor. Never sends QQ messages or changes the reply scope.

Keeps the engine connected to the verified QQ account and, after a restart or reconnect,
restores the owner's last reply choice (replying or paused)."""
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
LINUX = pathlib.Path.home() / 'dafeiyu-gpt'
CONFIG = pathlib.Path.home() / 'qq-runtime/config'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, json.dumps(data).encode() if data is not None else None,
                                 headers or {}, method='POST' if data is not None else 'GET')
    req.add_header('Content-Type', 'application/json')
    with opener.open(req, timeout=timeout) as response:
        return json.load(response)

class NapCat:
    def __init__(self, timeout=30):
        self.credential = None
        self.auth_time = 0
        self.timeout = timeout
    def login(self):
        token = json.loads((CONFIG / 'webui.json').read_text())['token']
        result = request('http://127.0.0.1:6099/api/auth/login', {'hash': hashlib.sha256((token+'.napcat').encode()).hexdigest()}, timeout=self.timeout)
        self.credential = result['data']['Credential']
        self.auth_time = time.monotonic()
    def call(self, route, data=None):
        if not self.credential or time.monotonic()-self.auth_time > 1800:
            self.login()
        for attempt in range(2):
            try:
                result = request('http://127.0.0.1:6099/api/'+route, data or {}, {'Authorization':'Bearer '+self.credential}, timeout=self.timeout)
            except urllib.error.HTTPError:
                result = {}
            if result.get('code') == 0:
                return result['data']
            # Opening NapCat's WebUI from the console signs in again, which retires this credential.
            if attempt == 0: self.login()
        raise RuntimeError('NapCat request failed: '+route)

class Panel:
    def __init__(self, url):
        parsed = urllib.parse.urlsplit(url)
        self.base = f'{parsed.scheme}://{parsed.netloc}'
        self.headers = {'X-QQ-Control': parsed.fragment, 'Origin': self.base}
    def status(self):
        return request(self.base+'/api/status',headers=self.headers)
    def action(self, action, **values):
        status = self.status()
        result = request(self.base+'/api/action', {'action':action,'configurationRevision':status['configurationRevision'],**values}, self.headers)
        if result.get('error'):
            raise RuntimeError(result['error'])
        return result

def save_status(**status):
    try:
        settings = json.loads((RUNTIME / 'providers.json').read_text())
        status['provider'] = settings['active']
        status['model'] = settings['profiles'][settings['active']]['model']
    except (OSError, ValueError, KeyError):
        pass
    temp = RUNTIME / 'status.tmp'
    temp.write_text(json.dumps(status,ensure_ascii=False))
    temp.replace(RUNTIME / 'status.json')

def load_desired():
    try: return json.loads((RUNTIME/'desired-running.json').read_text()).get('running') is True
    except (OSError, ValueError): return False

def save_desired(value):
    temp = RUNTIME / 'desired-running.tmp'
    temp.write_text(json.dumps({'running':value}))
    temp.replace(RUNTIME / 'desired-running.json')
    return value

def main():
    os.umask(0o077)
    RUNTIME.mkdir(exist_ok=True)
    save_status(engine=False,phase='starting')
    bridge = json.loads((RUNTIME/'bridge.json').read_text())
    onebot = json.loads((CONFIG/'onebot11.json').read_text())['network']['websocketServers'][0]['token']
    private = LINUX/'credentials.json'
    private.write_text(json.dumps({'token':onebot,'key':bridge['token']}))
    private.chmod(0o600)
    env = dict(os.environ,DAFEIYU_CODEX_URL='http://127.0.0.1:18191/v1',DAFEIYU_CREDENTIALS_FILE=str(private),DAFEIYU_DATA_DIR=str(LINUX/'data'),
               SWIFT_BACKTRACE='enable=yes,interactive=no,color=no')
    # stderr goes straight to the service log so crash reports survive; stdout is drained below.
    child = subprocess.Popen([str(LINUX/'upstream/dist/dafeiyu-linux/dafeiyu')],stdout=subprocess.PIPE,stderr=None,text=True,env=env)
    def stop(*_):
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try:
        while True:
            line = child.stdout.readline()
            if not line: raise RuntimeError('Engine failed to start')
            if line.startswith('QQ_CONTROL_URL='):
                url = line.split('=',1)[1].strip()
                (RUNTIME/'control-url.txt').write_text(url)
                panel = Panel(url)
                break
            print(line,end='',flush=True)
        # An undrained pipe eventually blocks the engine on its next log line.
        threading.Thread(target=lambda: [print(rest,end='',flush=True) for rest in child.stdout],daemon=True).start()
        nap = NapCat()
        save_status(engine=True,qqLoggedIn=False,phase='waiting_for_qq_login')
        print('Engine ready; waiting for QQ login.',flush=True)
        desired = load_desired()
        # Armed = replies have not been seen running since the engine (re)connected, so a stop is
        # not the owner's pause. Only then may the saved "replying" choice be restored.
        armed, last_connect = True, 0.0
        while child.poll() is None:
            try:
                login = nap.call('QQLogin/CheckLoginStatus')
                current = panel.status()
                if not current['connected']:
                    armed = True
                if login.get('isLogin') and not current['connected'] and time.monotonic()-last_connect > 20:
                    last_connect = time.monotonic()
                    info = nap.call('QQLogin/GetQQLoginInfo')
                    account = str(info.get('uin') or info.get('user_id') or '')
                    if not account.isdecimal(): raise RuntimeError('QQ account identity unavailable')
                    # Reconnect only after verifying the persisted expected identity, never silently switch accounts.
                    expected = current['config']['expectedSelfID']
                    if expected and expected != account: raise RuntimeError('QQ account differs from the saved account')
                    # NapCat keeps the login data, but needs an explicit account to reuse it on restart.
                    if str(nap.call('QQLogin/GetQuickLoginQQ') or '') != account:
                        nap.call('QQLogin/SetQuickLoginQQ', {'uin': account})
                    if current['config']['endpoint'] != 'ws://127.0.0.1:3001' or expected != account:
                        panel.action('saveConnection',endpoint='ws://127.0.0.1:3001',expectedSelfID=account)
                    current = panel.action('connect')
                    print('QQ identity and connection verified.',flush=True)
                if current['connected']:
                    if current['running']:
                        armed = False
                        if not desired: desired = save_desired(True)
                    elif armed:
                        # A failed or deferred resume stays armed and is retried on the next poll.
                        if not desired: armed = False
                        elif not current['busy']:
                            current = panel.action('start',durationMinutes=0,singleReply=False)
                            armed = False
                            print('Replies resumed as before the restart.',flush=True)
                    elif desired:
                        # Seen running on this connection and now stopped: the owner paused it.
                        desired = save_desired(False)
                save_status(engine=True,qqLoggedIn=bool(login.get('isLogin')),
                            phase='connected' if current['connected'] else 'waiting_for_qq_login',
                            connected=current['connected'],running=current['running'],desiredRunning=desired,
                            contactCount=len(current['contacts']),temporaryCredentials=current['temporaryCredentials'])
            except Exception as error:
                save_status(engine=True,phase='needs_attention',error=str(error),desiredRunning=desired)
            time.sleep(5)
        raise RuntimeError(f'Engine exited with code {child.returncode}')
    finally:
        if child.poll() is None: child.terminate()

if __name__=='__main__': main()
