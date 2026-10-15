"""Read-only post-recovery preservation/worker receipt. No Finish or controls."""
import datetime, hashlib, json, pathlib, runpy, subprocess
from urllib.parse import urlparse
C=runpy.run_path(str(pathlib.Path(__file__).with_name('dev-feature-client.py')))
ROOT,status,sk,api=(C[k] for k in ['ROOT','status','sk','api'])
R=json.loads((ROOT/'docs/evidence/dev-reliability-recovery.json').read_text())
assert 'finishedAt' in R
host=urlparse(C['bundle']['signalk_url']).hostname
code="""import pathlib,json,subprocess,hashlib
P=pathlib.Path.home()/'.openclaw'/'workspace'/'w42-scope-a-state';S=P/'signalk/plugin-config-data/signalk-wakelogger';B=P/'the882-recovery-before-20261015'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def cmd(a):return subprocess.check_output(a,text=True,timeout=20)
hashes=json.loads((B/'hashes.json').read_text());checks={}
for rel,h in hashes.items():
 assert digest(B/rel)==h
 if rel.endswith('.wlt') or 'scopea-disposable-device' in rel or rel.startswith('courses/'):
  assert digest(S/rel)==h;checks[rel]=True
choice=json.loads((S/'tracking-choice.json').read_text());assert choice['uploadMode']=='local_only' and choice['confirmed'];assert not (S/'tracking-pause.json').exists();assert not (B/'choice-held.json').exists()
assert (S/'tracking-choice.json').read_bytes()==(B/'tracking-choice.json').read_bytes()
old=json.loads((B/'services.json').read_text());services={}
for n,o in old.items():
 d=json.loads(cmd(['docker','inspect','wakelogger-scope-a-'+n+'-1']))[0]
 assert d['Id']==o['id'] and d['Image']==o['image'] and d['State']['Running']
 if n not in ['signalk','api']:assert d['State']['StartedAt']==o['startedAt']
 if n in ['signalk','api','db','minio','broker']:assert list(d['NetworkSettings']['Networks'])==['wakelogger-scope-a_isolated'] and not d['HostConfig']['PortBindings']
 services[n]={'sameId':True,'sameImage':True,'running':True,'startedAt':d['State']['StartedAt'],'untouched':n not in ['signalk','api']}
assert json.loads(cmd(['docker','network','inspect','wakelogger-scope-a_isolated']))[0]['Internal']
print(json.dumps({'backupHashesEqual':True,'unchangedFiles':checks,'choiceBytesRestored':True,'pauseAbsent':True,'faultFixtureRemoved':True,'services':services,'disk':cmd(['df','-h','/','/tmp']),'pathsRemoved':[],'bytesReclaimed':0}))
"""
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','nigel@'+host,'python3','-'],input=code,capture_output=True,text=True,timeout=60)
assert p.returncode==0,'remote preservation failed; inspect stderr privately'
F={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':json.loads(p.stdout),'tracking':status(),'course':sk('/plugins/signalk-wakelogger/course')[1]}
assert F['course']['legStart']==R['course']['legStart'] and F['tracking']['uploadMode']=='local_only' and not F['tracking']['liveTrackingEnabled'] and F['tracking']['trackingSessionId'] is None
q=F['tracking']['queue'];assert q['currentSequence']==q['acknowledgedSequence'] and q['messageCount']==q['droppedCount']==0
rows=C['api']('/v1/vessels/4/telemetry/overview')['recordings'];F['recordings']=rows
for old in R['originalRecordings']:
 now=next(r for r in rows if r['id']==old['id'])
 for k in ['state','expected_samples','received_samples','rejected_samples','missing_samples','first_sequence','last_sequence']:
  if k in old:assert now[k]==old[k]
F['originalRecordingsPreserved']=True
# Retrieve actual in-process worker health, through its authenticated HTTP overview.
F['worker']=api('/v1/admin/signalk/overview')['worker']
assert all(F['worker'][k] for k in ['enabled','started','thread_alive','leader','connected']) and not F['worker']['last_error']
(ROOT/'docs/evidence/dev-reliability-final-readback.json').write_text(json.dumps(F,indent=2)+'\n')
print('PASS final preservation, isolation, in-process receiver worker, complete records, queue/ACK, OFF')
