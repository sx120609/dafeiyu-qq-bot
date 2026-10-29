"""Real Swift engine -> local adapter -> GPT -> synthetic OneBot send. No real QQ sends."""
import base64, hashlib, json, os, pathlib, runpy, select, socket, subprocess, sys, tempfile, threading, time
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from supervisor import Panel
transport=runpy.run_path(str(ROOT/'upstream/scripts/test-onebot-transport.py'))
exact,receive,send=[transport[n] for n in ('exact','receive','send')]
binary=pathlib.Path(os.environ.get('DAFEIYU_TEST_BINARY',str(pathlib.Path.home()/'dafeiyu-gpt/upstream/dist/dafeiyu-linux/dafeiyu')))
bridge=json.loads((ROOT/'.runtime/bridge.json').read_text())

def scenario(group,mode='normal'):
    ready=threading.Event(); received=threading.Event(); errors=[]; outgoing=[]; history=[]
    with socket.socket() as listener, tempfile.TemporaryDirectory(prefix='dafeiyu-e2e-') as directory:
        listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(20)
        def serve():
            try:
                conn,_=listener.accept()
                with conn:
                    conn.settimeout(20);header=b''
                    while b'\r\n\r\n' not in header:header+=exact(conn,1)
                    fields=dict(line.split(': ',1) for line in header.decode().split('\r\n')[1:] if ': ' in line)
                    fields={k.lower():v for k,v in fields.items()}
                    assert fields['authorization']=='Bearer synthetic-test-token'
                    accept=base64.b64encode(hashlib.sha1((fields['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n').encode())
                    injected=False;beat=0;end=time.monotonic()+350
                    while time.monotonic()<end:
                        if time.monotonic()-beat>5:
                            send(conn,{'post_type':'meta_event','meta_event_type':'heartbeat','self_id':12345,'status':{'online':True,'good':True},'interval':5000});beat=time.monotonic()
                        if ready.is_set() and not injected:
                            utterance={'model':'你具体用的什么模型？','image':'大肥鱼，请画一张蓝色的小鲸鱼，不要文字。','normal':'大肥鱼，我把面和料包一起扔了，只剩一碗热水。','name':'大肥鱼，晚上吃什么好？'}[mode]
                            event={'post_type':'message','message_type':'group' if group else 'private','sub_type':'normal' if group else 'friend','self_id':12345,'user_id':54321,'sender':{'user_id':54321,'nickname':'合成测试用户'},'message_id':1,'time':time.time(),'message':[{'type':'text','data':{'text':utterance}}]}
                            if group:
                                event['group_id']=99999
                                # An ordinary group message must not trigger generation.
                                send(conn,dict(event,message=[{'type':'text','data':{'text':'群里普通路过一句，不是对任何机器人说话。'}}]))
                                event=dict(event,message_id=2,message=event['message'] if mode=='name' else [{'type':'at','data':{'qq':'12345'}},*event['message']])
                            history.append(event);send(conn,event);send(conn,event);injected=True
                        if not select.select([conn],[],[],0.1)[0]:continue
                        req=receive(conn);action=req['action']
                        if action=='get_login_info':data={'user_id':12345}
                        elif action=='get_status':data={'online':True,'good':True}
                        elif action=='get_friend_list':data=[{'user_id':54321,'nickname':'合成测试用户'}]
                        elif action=='get_group_list':data=[{'group_id':99999,'group_name':'合成测试群'}]
                        elif action=='get_friend_msg_history':data={'messages':history}
                        elif action in ('send_private_msg','send_group_msg'):
                            assert action==('send_group_msg' if group else 'send_private_msg')
                            outgoing.append(req['params']);data={'message_id':901};received.set()
                        else:raise AssertionError('Unexpected action '+action)
                        send(conn,{'status':'ok','retcode':0,'data':data,'echo':req['echo']})
            except (EOFError,BrokenPipeError,ConnectionResetError):pass
            except Exception as e:errors.append(repr(e));received.set()
        worker=threading.Thread(target=serve,daemon=True);worker.start()
        env=dict(os.environ,DAFEIYU_DATA_DIR=directory,DAFEIYU_CODEX_URL=os.environ.get('DAFEIYU_TEST_MODEL_URL','http://127.0.0.1:18191/v1'))
        env.pop('DAFEIYU_CREDENTIALS_FILE',None)
        process=subprocess.Popen([str(binary)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
        try:
            line=process.stdout.readline();assert line.startswith('QQ_CONTROL_URL='),line
            panel=Panel(line.strip().split('=',1)[1])
            panel.action('saveConnection',endpoint=f'ws://127.0.0.1:{listener.getsockname()[1]}',expectedSelfID='12345')
            state=panel.action('connect',token='synthetic-test-token',key=bridge['token'])
            target='group:99999' if group else 'private:54321'
            panel.action('add',target=target)
            state=panel.status();ai=state['config']['ai'];ai.update(model='gpt-6-astra',cooldownSeconds=1)
            persona=state['persona'];persona['stickersEnabled']=False
            persona.update(style='custom',customName='大肥鱼',customPrompt=(ROOT/'personas/dafeiyu.txt').read_text(),maxCharacters=180)
            panel.action('save',ai=ai,persona=persona,enabled=[target],onlineEnabled=True,visionEnabled=True,memoryEnabled=False,groupParticipationEnabled=False,naturalRepliesEnabled=True,loopProtectionEnabled=True)
            if mode=='image':panel.action('saveImageGeneration',imageGeneration={'enabled':True,'primary':'codex','fallbackEnabled':False,'cloudflareAccountID':''},persistImageCredentials=False)
            panel.action('start',singleReply=True)
            started=time.monotonic()
            ready.set();assert received.wait(300 if mode=='image' else 180),'No synthetic reply within timeout'
            assert not errors,errors
            time.sleep(1)
            state=panel.status()
            assert len(outgoing)==1,outgoing
            assert state['confirmed']==1 and not state['running'],{k:state[k] for k in ('confirmed','running','error','status')}
            text=''.join(p['data'].get('text','') for p in outgoing[0]['message'] if p['type']=='text')
            assert text and '格式' not in text,text
            if mode=='model':assert state['calls']==0 and os.environ.get('DAFEIYU_EXPECTED_MODEL','gpt-6-astra') in text,text
            has_image=any(p['type']=='image' for p in outgoing[0]['message'])
            if mode=='image':assert has_image,'Generated image did not reach synthetic OneBot'
            print(json.dumps({'scenario':('group_' if group else 'private_')+mode,'reply':text,'confirmed':state['confirmed'],'calls':state['calls'],'elapsedMs':round((time.monotonic()-started)*1000),'image':has_image,'duplicate_suppressed':True},ensure_ascii=False),flush=True)
        finally:
            process.terminate();process.wait(timeout=10);worker.join(timeout=3)

cases=os.environ.get('DAFEIYU_TEST_SCENARIOS','private,group').split(',')
for case in cases:scenario(case in ('group','name'),{'model':'model','name':'name','image':'image'}.get(case,'normal'))
