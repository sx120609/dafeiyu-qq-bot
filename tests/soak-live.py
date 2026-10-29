"""Continuous-run soak: real engine + real model gateway + synthetic OneBot. No real QQ sends.

Keeps the engine replying across several turns with memory enabled, then idles so background
work (memory learning, follow-up windows) runs. Fails if the engine process exits; its stderr
is kept under .runtime/soak/ for crash reports.
"""
import base64, hashlib, json, os, pathlib, runpy, select, socket, subprocess, sys, tempfile, threading, time
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from supervisor import Panel
transport=runpy.run_path(str(ROOT/'upstream/scripts/test-onebot-transport.py'))
exact,receive,send=[transport[n] for n in ('exact','receive','send')]
binary=pathlib.Path(os.environ.get('DAFEIYU_TEST_BINARY',str(pathlib.Path.home()/'dafeiyu-gpt/upstream/dist/dafeiyu-linux/dafeiyu')))
bridge=json.loads((ROOT/'.runtime/bridge.json').read_text())
idle=int(os.environ.get('DAFEIYU_SOAK_IDLE','150'))
turns_file=os.environ.get('DAFEIYU_SOAK_TURNS_FILE')
turns=(json.loads(pathlib.Path(turns_file).read_text(encoding='utf-8')) if turns_file else None) or [
    (False,'在吗，帮我想想今晚吃什么'),
    (False,'那不想吃辣的呢'),
    (True,'大肥鱼，你觉得周末去爬山还是看电影'),
    (True,'为什么啊'),
    (False,'你具体用的什么模型？'),
]
logdir=ROOT/'.runtime/soak';logdir.mkdir(parents=True,exist_ok=True)
stderr_path=logdir/f'engine-stderr-{time.strftime("%Y%m%d-%H%M%S")}.log'

lock=threading.Lock();outgoing=[];history=[];actions={};errors=[]
conn_ref={}
def serve(listener):
    try:
        conn,_=listener.accept();conn_ref['conn']=conn
        with conn:
            conn.settimeout(30);header=b''
            while b'\r\n\r\n' not in header:header+=exact(conn,1)
            fields={k.lower():v for k,v in (line.split(': ',1) for line in header.decode().split('\r\n')[1:] if ': ' in line)}
            accept=base64.b64encode(hashlib.sha1((fields['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n').encode())
            beat=0;sent=901
            while True:
                if time.monotonic()-beat>5:
                    with lock:send(conn,{'post_type':'meta_event','meta_event_type':'heartbeat','self_id':12345,'status':{'online':True,'good':True},'interval':5000})
                    beat=time.monotonic()
                if not select.select([conn],[],[],0.1)[0]:continue
                with lock:req=receive(conn)
                action=req['action'];actions[action]=actions.get(action,0)+1
                if action=='get_login_info':data={'user_id':12345,'nickname':'大肥鱼'}
                elif action=='get_status':data={'online':True,'good':True}
                elif action=='get_friend_list':data=[{'user_id':54321,'nickname':'合成测试用户'}]
                elif action=='get_group_list':data=[{'group_id':99999,'group_name':'合成测试群'}]
                elif action=='get_friend_msg_history':
                    peer=str(req['params'].get('user_id'))
                    data={'messages':[e for e in history if e['message_type']=='private' and str(e['user_id'])==peer]}
                elif action=='get_group_msg_history':data={'messages':[e for e in history if e['message_type']=='group']}
                elif action in ('send_private_msg','send_group_msg'):
                    sent+=1;outgoing.append((time.time(),action,req['params']));data={'message_id':sent}
                else:data={}
                with lock:send(conn,{'status':'ok','retcode':0,'data':data,'echo':req['echo']})
    except (EOFError,BrokenPipeError,ConnectionResetError,OSError):pass
    except Exception as e:errors.append(repr(e))

def inject(group,text,message_id,image=None,sender=54321):
    segments=[{'type':'text','data':{'text':text}}]
    if image:segments.append({'type':'image','data':{'url':image,'file':'synthetic.jpg'}})
    event={'post_type':'message','message_type':'group' if group else 'private','sub_type':'normal' if group else 'friend','self_id':12345,
           'user_id':sender,'sender':{'user_id':sender,'nickname':'合成测试用户'},'message_id':message_id,'time':time.time(),
           'message':segments,'raw_message':text}
    if group:event['group_id']=99999
    history.append(event)
    with lock:send(conn_ref['conn'],event)

with socket.socket() as listener, tempfile.TemporaryDirectory(prefix='dafeiyu-soak-') as directory, open(stderr_path,'w') as err:
    listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(30)
    threading.Thread(target=serve,args=(listener,),daemon=True).start()
    env=dict(os.environ,DAFEIYU_DATA_DIR=directory,DAFEIYU_CODEX_URL=os.environ.get('DAFEIYU_TEST_MODEL_URL','http://127.0.0.1:18191/v1'),
             SWIFT_BACKTRACE='enable=yes,interactive=no,color=no')
    env.pop('DAFEIYU_CREDENTIALS_FILE',None)
    process=subprocess.Popen([str(binary)],stdout=subprocess.PIPE,stderr=err,text=True,env=env)
    out=[]
    try:
        line=process.stdout.readline();assert line.startswith('QQ_CONTROL_URL='),line
        threading.Thread(target=lambda:[out.append(l) for l in process.stdout],daemon=True).start()
        panel=Panel(line.strip().split('=',1)[1])
        panel.action('saveConnection',endpoint=f'ws://127.0.0.1:{listener.getsockname()[1]}',expectedSelfID='12345')
        panel.action('connect',token='synthetic-test-token',key=bridge['token'])
        for target in ('private:54321','group:99999'):panel.action('add',target=target)
        state=panel.status();ai=state['config']['ai'];ai.update(model='dafeiyu-active',cooldownSeconds=1,maxTokens=2000)
        persona=state['persona'];persona['stickersEnabled']=False
        persona.update(style='custom',customName='大肥鱼',customPrompt=(ROOT/'personas/dafeiyu.txt').read_text(encoding='utf-8'),maxCharacters=800)
        panel.action('save',ai=ai,persona=persona,enabled=['private:54321','group:99999'],onlineEnabled=True,visionEnabled=True,memoryEnabled=True,
                     groupParticipationEnabled=False,naturalRepliesEnabled=True,loopProtectionEnabled=True,fastReplyEnabled=True)
        if os.environ.get('DAFEIYU_SOAK_ADMIN'):panel.action('saveModeration',adminIDs=[os.environ['DAFEIYU_SOAK_ADMIN']],blockedIDs=[])
        if os.environ.get('DAFEIYU_SOAK_REACTIONS'):
            reactions=dict(panel.status()['reactions']);reactions.update(enabled=True,chance=100,cooldownSeconds=0)
            panel.action('saveReactions',reactions=reactions)
        if os.environ.get('DAFEIYU_SOAK_OUTREACH'):
            # One quiet minute is enough to start a conversation; no quiet hours during the test.
            panel.action('saveOutreach',outreach={'enabled':True,'idleMinutes':1,'cooldownMinutes':1,'quietStartHour':0,'quietEndHour':0,'timeZone':'Asia/Shanghai','excluded':[]})
        panel.action('start',durationMinutes=0)
        started=time.monotonic();message_id=100;failures=[]
        for turn in turns:
            turn=turn if isinstance(turn,dict) else {'group':turn[0],'text':turn[1]}
            if 'idle' in turn:
                # Say nothing and watch for messages the bot starts on its own.
                before=len(outgoing);time.sleep(turn['idle'])
                parts=[''.join(p['data'].get('text','') for p in item[2]['message'] if p['type']=='text') for item in outgoing[before:]]
                if bool(parts)!=turn['unprompted']:failures.append(f"idle {turn['idle']}s unprompted={bool(parts)}")
                print(json.dumps({'t':round(time.monotonic()-started),'idle':turn['idle'],'unprompted':' ‖ '.join(parts) or None,'alive':process.poll() is None},ensure_ascii=False),flush=True)
                if process.poll() is not None:break
                continue
            before=len(outgoing);message_id+=1
            inject(turn.get('group',False),turn['text'],message_id,turn.get('image'),turn.get('sender',54321))
            expect=turn.get('expectReply',True);deadline=time.monotonic()+(180 if expect else 25)
            while len(outgoing)==before and time.monotonic()<deadline and process.poll() is None:time.sleep(0.5)
            # A reply may arrive as several messages; collect until the bot has been quiet for 5 s.
            seen=len(outgoing);quiet=time.monotonic()
            while len(outgoing)>before and time.monotonic()-quiet<5:
                time.sleep(0.5)
                if len(outgoing)!=seen:seen=len(outgoing);quiet=time.monotonic()
            parts=[''.join(p['data'].get('text','') for p in item[2]['message'] if p['type']=='text') for item in outgoing[before:]]
            reply=' ‖ '.join(parts) if parts else None
            if (reply is not None)!=expect or (turn.get('contains') and turn['contains'] not in (reply or '')):failures.append(turn['text'])
            print(json.dumps({'t':round(time.monotonic()-started),'in':turn['text'],'reply':reply,'alive':process.poll() is None},ensure_ascii=False),flush=True)
            if process.poll() is not None:break
            time.sleep(3)
        end=time.monotonic()+idle
        while time.monotonic()<end and process.poll() is None:time.sleep(1)
        alive=process.poll() is None
        if os.environ.get('DAFEIYU_SOAK_REACTIONS'):
            group_turns=sum(1 for t in turns if isinstance(t,dict) and t.get('group'))
            if actions.get('set_msg_emoji_like',0)<group_turns:failures.append(f"reactions {actions.get('set_msg_emoji_like',0)}/{group_turns}")
        status=panel.status() if alive else {}
        print(json.dumps({'alive':alive,'exit':process.returncode,'sent':len(outgoing),'actions':actions,'errors':errors,'unexpected':failures,
                          'memoryStatus':status.get('memoryStatus'),'running':status.get('running'),'calls':status.get('calls'),
                          'stderr':str(stderr_path)},ensure_ascii=False),flush=True)
        if not alive or failures:sys.exit(1)
    finally:
        if process.poll() is None:process.terminate();process.wait(timeout=10)
