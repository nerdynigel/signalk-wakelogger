"""THE-882 serialized isolated DEV proof. Single-use: inspect receipt before continuation.
Run-bound secrets stay in memory. No pairing, setup replay, outbox reset or product edit.
"""
import datetime, hashlib, json, pathlib, runpy, subprocess, time, urllib.request
from urllib.parse import urlparse
C = runpy.run_path(str(pathlib.Path(__file__).with_name('dev-feature-client.py')))
ROOT, status, sk, mode, api = (C[k] for k in ['ROOT', 'status', 'sk', 'mode', 'api'])
HOST = urlparse(C['bundle']['signalk_url']).hostname
OUT = ROOT / 'docs/evidence/dev-reliability-recovery.json'
assert not OUT.exists(), 'single-use evidence exists: reconcile, never replay'
R = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'cases': []}
def save(): OUT.write_text(json.dumps(R, indent=2)+'\n')
def remote(code):
 p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','nigel@'+HOST,'python3','-'],input=code,capture_output=True,text=True,timeout=100)
 assert p.returncode==0, 'remote operation failed (inspect private stderr before retry)'
 return json.loads(p.stdout)
PRE="""import pathlib,json,subprocess,hashlib,shutil,os,time
P=pathlib.Path.home()/'.openclaw'/'workspace'/'w42-scope-a-state';S=P/'signalk/plugin-config-data/signalk-wakelogger';B=P/'the882-recovery-before-20261015'
def cmd(a):return subprocess.check_output(a,text=True,timeout=70)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
"""
def ready():
 for _ in range(50):
  try:
   s=status()
   if s.get('ready') is not False and s.get('connectionState') not in ['starting','initializing']: return s
  except Exception: pass
  time.sleep(1)
 raise AssertionError('native readiness timeout')
def restart(service):
 assert service in ['signalk','api']
 started=time.monotonic()
 r=remote(PRE+"n='wakelogger-scope-a-"+service+"-1';d=json.loads(cmd(['docker','inspect',n]))[0];assert d['NetworkSettings']['Networks'].keys()=={'wakelogger-scope-a_isolated'} and not d['HostConfig']['PortBindings'];assert json.loads(cmd(['docker','network','inspect','wakelogger-scope-a_isolated']))[0]['Internal'];cmd(['docker','restart','--time','20',n]);print(json.dumps({'name':n,'restartExit':0,'sameId':json.loads(cmd(['docker','inspect',n]))[0]['Id']==d['Id']}))")
 if service=='signalk':ready()
 else:
  for _ in range(60):
   try:
    with urllib.request.urlopen(C['bundle']['api_base_url']+'/ready',timeout=3) as q:
     if q.status==200:break
   except Exception: pass
   time.sleep(1)
  else:raise AssertionError('API ready timeout')
 r['recoverySeconds']=round(time.monotonic()-started,2);assert r['recoverySeconds']<900
 R['cases'].append(r);save();return r

def overview():return api('/v1/vessels/4/telemetry/overview')['recordings']
def course():return sk('/plugins/signalk-wakelogger/course')[1]
def preserved():
 rows={r['id']:r for r in overview()}
 for old in R['originalRecordings']:
  now=rows[old['id']]
  for k in ['state','expected_samples','received_samples','rejected_samples','missing_samples','first_sequence','last_sequence']:
   if k in old:assert now[k]==old[k], (old['id'],k)
 assert course()['legStart']==R['course']['legStart'], 'activation marker changed'
 return True

p=None
try:
 R['before']=status();assert R['before']['uploadMode']=='local_only' and R['before']['trackingSessionId'] is None
 R['originalRecordings']=overview();R['course']=course();save()
 R['beforeHost']=remote(PRE+"""
assert not B.exists();B.mkdir(mode=0o700)
shutil.copy2(S/'tracking-choice.json',B/'tracking-choice.json')
for name in ['courses','recordings','track-archive','outbox']:
 shutil.copytree(S/name,B/name)
services={}
for name in ['signalk','api','db','minio','broker','frontend','gateway']:
 d=json.loads(cmd(['docker','inspect','wakelogger-scope-a-'+name+'-1']))[0]
 services[name]={'id':d['Id'],'image':d['Image'],'startedAt':d['State']['StartedAt'],'running':d['State']['Running'],'networks':list(d['NetworkSettings']['Networks']),'ports':d['HostConfig']['PortBindings']}
 assert d['State']['Running']
 if name in ['signalk','api','db','minio','broker']:assert services[name]['networks']==['wakelogger-scope-a_isolated'] and not services[name]['ports']
assert json.loads(cmd(['docker','network','inspect','wakelogger-scope-a_isolated']))[0]['Internal']
hashes={str(p.relative_to(S)):digest(p) for n in ['courses','recordings','track-archive','outbox'] for p in (S/n).rglob('*') if p.is_file()}
(B/'hashes.json').write_text(json.dumps(hashes));(B/'services.json').write_text(json.dumps(services))
print(json.dumps({'services':services,'hashes':hashes,'privateBackupRelativeToStateRoot':B.name,'disk':cmd(['df','-h','/'])}))
""")
 R['servedHashes']={}
 for name in ['app.mjs','leg-eta.mjs','course-progress.mjs','instruments.mjs','tracking-controls.mjs']:
  with urllib.request.urlopen(C['bundle']['signalk_url']+'/signalk-wakelogger/'+name,timeout=10) as q:b=q.read()
  assert b==(ROOT/'public'/name).read_bytes();R['servedHashes'][name]=hashlib.sha256(b).hexdigest()
 save();restart('signalk');s=status();assert s['uploadMode']==s['persistedUploadMode']=='local_only' and s['trackingSessionId'] is None
 assert s['queue']==R['before']['queue'];assert s['finishedTrip']['manifest']==R['before']['finishedTrip']['manifest'];assert preserved()
 R['offRestart']=s;save();print('PASS OFF restart, queue/manifest/route marker preserved',flush=True)
 # EISDIR is an unreadable choice, independent of permission/root behavior.
 remote(PRE+"q=S/'tracking-choice.json';assert q.is_file();q.rename(B/'choice-held.json');q.mkdir();print('{}')")
 try:
  restart('signalk');s=status();assert s['uploadMode']==s['persistedUploadMode']=='local_only' and s.get('persistenceError');assert preserved();R['unreadableChoice']=s;save()
 finally:
  remote(PRE+"q=S/'tracking-choice.json';q.rmdir();(B/'choice-held.json').rename(q);print('{}')")
 R['choiceRecovered']=mode('local_only');save();print('PASS unreadable choice fail-off/restoration',flush=True)
 # Force only durable choice replacement to fail. Prior choice remains private/intact.
 remote(PRE+"q=S/'tracking-choice.json';q.rename(B/'choice-held.json');q.mkdir();print('{}')")
 try:
  code,s=sk(body={'uploadMode':'automatic','confirmed':True,'expectedUploadMode':'local_only'})
  R['failedSave']={'http':code,'status':s};save();assert code==503 and s['error']=='tracking_persistence_failed' and s['uploadMode']==s['persistedUploadMode']=='local_only'
  R['pauseGuard']=remote(PRE+"assert (S/'tracking-pause.json').is_file();assert (B/'choice-held.json').read_bytes()==(B/'tracking-choice.json').read_bytes();print(json.dumps({'guard':True,'priorDurableChoiceEqual':True}))");save()
 finally:
  remote(PRE+"q=S/'tracking-choice.json';q.rmdir();(B/'choice-held.json').rename(q);print('{}')")
 restart('signalk');s=status();assert s['uploadMode']=='local_only' and s.get('persistenceError');R['failedSaveRestart']=s
 R['saveRecovery']=mode('local_only');assert not R['saveRecovery'].get('persistenceError');save();print('PASS failed save503, durable preservation, restart safety guard/recovery',flush=True)
 # A single new native-input fixture continues across plugin and receiver restarts.
 js=r"""const fs=require('fs'),WS=require('ws');const q=JSON.parse(fs.readFileSync(0,'utf8'));let n=0;function connect(){const w=new WS(q.url,{headers:{Authorization:'Bearer '+q.token}});let t;w.on('open',()=>{t=setInterval(()=>{w.send(JSON.stringify({context:'vessels.self',updates:[{$source:'THE882.synthetic.recovery',timestamp:new Date().toISOString(),values:[{path:'navigation.position',value:{latitude:-33.86,longitude:151.211+n++*.00002}},{path:'navigation.speedOverGround',value:2.6},{path:'navigation.courseOverGroundTrue',value:1.57},{path:'navigation.headingTrue',value:1.57},{path:'environment.wind.speedApparent',value:5.5},{path:'environment.wind.angleApparent',value:.7}]}]}))},1000)});w.on('error',()=>w.close());w.on('close',()=>{clearInterval(t);setTimeout(connect,1000)})}connect();"""
 p=subprocess.Popen(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node','-e',js],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True)
 p.stdin.write(json.dumps({'url':C['bundle']['signalk_url'].replace('http:','ws:')+'/signalk/v1/stream?subscribe=none','token':C['values']['rw']}));p.stdin.close()
 R['enabled']=mode('automatic');save()
 for _ in range(50):
  s=status()
  if s['trackingSessionId']:break
  time.sleep(1)
 sid=s['trackingSessionId'];assert sid and sid not in {r['id'] for r in R['originalRecordings']};R['newRecordingId']=sid;R['beforeOnRestart']=s;save()
 restart('signalk');s=status();assert s['uploadMode']==s['persistedUploadMode']=='automatic' and s['trackingSessionId']==sid
 assert s['queue']['currentSequence']>=R['beforeOnRestart']['queue']['currentSequence'];assert preserved();R['afterOnRestart']=s;save();print('PASS ON restart same recording and route marker',flush=True)
 R['beforeReceiverRestart']=status();save();restart('api')
 for _ in range(45):
  s=status()
  if s['queue']['acknowledgedSequence']>R['beforeReceiverRestart']['queue']['acknowledgedSequence']:break
  time.sleep(1)
 assert s['trackingSessionId']==sid and s['queue']['acknowledgedSequence']>R['beforeReceiverRestart']['queue']['acknowledgedSequence'];R['afterReceiverRestart']=s;save();print('PASS receiver restart and advancing real ACK',flush=True)
 # Qualifying real sampler duration, retaining all native samples and no Finish replay.
 started=time.time()
 while time.time()-started<135:
  time.sleep(5)
  s=status();assert s['trackingSessionId']==sid and s['uploadMode']=='automatic'
 R['beforeFinish']=status();save()
 p.terminate();p.wait(timeout=10);p=None
 code,s=sk('/plugins/signalk-wakelogger/tracking/finish',{'expectedRecordingId':sid});R['finish']={'http':code,'status':s};save();assert code==200
 manifest=s['finishedTrip']['manifest'];assert manifest['id']==sid and manifest['state']=='complete'
 for _ in range(60):
  rec=next((r for r in overview() if r['id']==sid),None)
  if rec and rec['state']=='ready':break
  time.sleep(1)
 assert rec and rec['state']=='ready' and rec['expected_samples']==rec['received_samples']==manifest['lastSequence']-manifest['firstSequence']+1 and rec['missing_samples']==rec['rejected_samples']==0
 R['receiverComplete']=rec;R['offBeforeRetry']=mode('local_only');save()
 restart('signalk');code,s=sk('/plugins/signalk-wakelogger/tracking/finish',{'expectedRecordingId':sid})
 R['finishRetryAfterRestart']={'http':code,'sameManifest':s.get('finishedTrip',{}).get('manifest')==manifest};save();assert code==200 and R['finishRetryAfterRestart']['sameManifest']
 # Normal reconnect obtains terminal status; Finish is not repeated.
 mode('automatic')
 for _ in range(30):
  s=status()
  if not s['finishedTrip']['confirmationPending']:break
  time.sleep(1)
 assert not s['finishedTrip']['confirmationPending'];R['terminal']=s;assert preserved();save()
 print('PASS new Finish receiver completeness and one same-ID retry after process restart',flush=True)
finally:
 if p and p.poll() is None:p.terminate();p.wait(timeout=10)
 R['finalOff']=mode('local_only');save()
 assert R['finalOff']['uploadMode']==R['finalOff']['persistedUploadMode']=='local_only' and not R['finalOff']['liveTrackingEnabled']
 R['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
print('PASS serialized recovery tranche; final confirmed OFF',flush=True)
