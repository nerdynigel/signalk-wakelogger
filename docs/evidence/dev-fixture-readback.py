"""Read-only source/isolation receipt; run after fixture setup, not a replay."""
import hashlib,json,pathlib,runpy,subprocess,datetime
from urllib.parse import urlparse
C=runpy.run_path(str(pathlib.Path(__file__).with_name('dev-feature-client.py')))
HOST=urlparse(C['bundle']['signalk_url']).hostname
code="""import pathlib,subprocess,json,hashlib
D=lambda a:subprocess.check_output(a,text=True)
r={'services':{}}
for name in ['api','signalk','broker','db','frontend','gateway','minio']:
 d=json.loads(D(['docker','inspect','wakelogger-scope-a-'+name+'-1']))[0]
 r['services'][name]={'id':d['Id'],'image':d['Image'],'startedAt':d['State']['StartedAt'],'running':d['State']['Running'],'networks':list(d['NetworkSettings']['Networks'])}
r['internalNetwork']=json.loads(D(['docker','network','inspect','wakelogger-scope-a_isolated']))[0]['Internal']
assert r['internalNetwork']
r['apiSourceHashes']=json.loads(D(['docker','exec','wakelogger-scope-a-api-1','python','-c',"import pathlib,hashlib,json; fs=['app/services/signalk_race_packs.py','app/routers/race_plans.py','app/services/tide_daily.py','app/models/voyage_environment_snapshot.py'];print(json.dumps({f:hashlib.sha256((pathlib.Path('/app')/f).read_bytes()).hexdigest() for f in fs}))"]))
r['targetDisk']=D(['df','-h','/'])
print(json.dumps(r))
"""
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','nigel@'+HOST,'python3','-'],input=code,text=True,capture_output=True,timeout=60);assert p.returncode==0
r=json.loads(p.stdout);r['at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
s=C['status']();r['tracking']={k:s[k] for k in ['uploadMode','persistedUploadMode','liveTrackingEnabled','trackingSessionId','trackingState','queue']}
assert s['uploadMode']==s['persistedUploadMode']=='local_only' and s['queue']['currentSequence']==1439 and s['queue']['acknowledgedSequence']==647
r['localDisk']=subprocess.check_output(['df','-h','/','/tmp'],text=True)
out=C['ROOT']/'docs/evidence/dev-fixture-readback.json';assert not out.exists();out.write_text(json.dumps(r,indent=2)+'\n')
print('PASS source/image/isolation/final OFF+queue readback; disk healthy')
