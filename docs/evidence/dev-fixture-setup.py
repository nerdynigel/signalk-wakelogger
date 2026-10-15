"""THE-882 scoped fixture orchestrator. Never replay existing receipts blindly."""
import datetime,hashlib,json,pathlib,runpy,subprocess,sys,urllib.request
from urllib.parse import urlparse
C=runpy.run_path(str(pathlib.Path(__file__).with_name('dev-feature-client.py')))
ROOT=C['ROOT'];HOST=urlparse(C['bundle']['signalk_url']).hostname
mode=sys.argv[1];assert mode in ['setup','rollback']
OUT=ROOT/'docs/evidence'/('dev-fixture-'+mode+'.json');assert not OUT.exists(),'receipt exists: reconcile first'
s=C['status']();assert s['uploadMode']==s['persistedUploadMode']=='local_only' and not s['liveTrackingEnabled']
course=C['sk']('/plugins/signalk-wakelogger/course')[1]
R={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'before':s,'courseBefore':course,'recordingsBefore':C['api']('/v1/vessels/4/telemetry/overview')['recordings']}
source=(ROOT/'docs/evidence/dev-fixture-api.py').read_text()
remote="""import subprocess,json
D=lambda a:subprocess.check_output(a,text=True)
for name in ['api','broker','db','signalk']:
 d=json.loads(D(['docker','inspect','wakelogger-scope-a-'+name+'-1']))[0]
 assert d['State']['Running'] and list(d['NetworkSettings']['Networks'])==['wakelogger-scope-a_isolated'] and not d['HostConfig']['PortBindings']
assert json.loads(D(['docker','network','inspect','wakelogger-scope-a_isolated']))[0]['Internal']
p=subprocess.run(['docker','exec','-i','wakelogger-scope-a-api-1','python','-',MODE],input=SOURCE,text=True,capture_output=True,timeout=60)
assert p.returncode==0,p.stderr[-1500:]
print(p.stdout)
""".replace('MODE',repr(mode)).replace('SOURCE',repr(source))
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','nigel@'+HOST,'python3','-'],input=remote,text=True,capture_output=True,timeout=90)
if p.returncode:print(p.stderr[-2000:]);raise SystemExit(1)
R['fixture']=json.loads(p.stdout)
code,recalc=C['request'](C['bundle']['api_base_url'],'/v1/race-plan/25/recalculate',C['token'],body={});assert code==200
R['recalculate']=recalc
R['packAfter']=C['sk']('/plugins/signalk-wakelogger/race-plan')[1]
R['voyageAfter']=C['api']('/v1/voyages/4')
R['after']=C['status']();R['courseAfter']=C['sk']('/plugins/signalk-wakelogger/course')[1]
assert R['after']['uploadMode']=='local_only' and R['after']['queue']==R['before']['queue'] and R['after']['trackingSessionId']==R['before']['trackingSessionId']
assert R['courseAfter']['legStart']==R['courseBefore']['legStart']
rows=C['api']('/v1/vessels/4/telemetry/overview')['recordings'];assert rows==R['recordingsBefore']
R['servedHashes']={}
for name in ['app.mjs','leg-eta.mjs','course-progress.mjs','instruments.mjs','tracking-controls.mjs']:
 with urllib.request.urlopen(C['bundle']['signalk_url']+'/signalk-wakelogger/'+name,timeout=10) as q:b=q.read()
 assert b==(ROOT/'public'/name).read_bytes();R['servedHashes'][name]=hashlib.sha256(b).hexdigest()
OUT.write_text(json.dumps(R,indent=2)+'\n')
print('PASS',mode,'queue/recordings/marker/OFF preserved; five served hashes equal; ACK=',R['fixture']['acks'])
print('PACK',R['packAfter']['pack'])
print('TIDE',recalc.get('tide_snapshot_json'))
print('VOYAGE TIDE',{k:v for k,v in R['voyageAfter'].items() if 'tide' in k})
