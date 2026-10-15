"""Read back the completed new recording after a pre-Finish queue assertion race.
One deliberate same-ID retry; no telemetry/setup/first Finish replay.
"""
import json
from pathlib import Path
import runpy
import datetime
C = runpy.run_path(str(Path(__file__).with_name('dev-feature-endpoints.py')))
pc, request, ROOT = (C[k] for k in ['pc', 'request', 'ROOT'])
R = json.loads((ROOT / 'docs/evidence/dev-feature-recording.json').read_text())
sid = R['recordingId'];assert sid == 'b7a21084-985b-437a-a3f9-b1328842d6dd'
keys = {'rw':'openclaw_scope_a_signalk_readwrite_20261015111327','identity':'wakelogger_scope_a_qa_identity_20261015111327'}
assert set(keys.values()) <= {e['key'] for e in pc('/api/agents/me/secrets')['secrets']}
v = {k:pc('/api/agents/me/secrets/'+key+'/value','POST')['value'] for k,key in keys.items()};bundle=json.loads(v.pop('identity'))
def sk(body=None,finish=False):
 return request(bundle['signalk_url'],'/plugins/signalk-wakelogger/tracking'+('/finish' if finish else ''),v['rw'],body)
code,before=sk();assert code==200 and before['uploadMode']=='local_only'
manifest=before['finishedTrip']['manifest'];assert manifest==R['finish']['finishedTrip']['manifest'] and manifest['id']==sid
assert manifest['lastSequence'] >= R['beforeFinish']['queue']['currentSequence']
assert manifest['lastSequence'] == R['finish']['queue']['currentSequence']
# The earlier execution performed and verified exactly one same-ID retry.
# It then stopped on missing terminal notification, after receiver checks.
code,retry=sk();assert code==200 and retry['finishedTrip']['manifest']==manifest
code,login=request(bundle['api_base_url'],'/v1/auth/login',body={'email':bundle['email'],'password':bundle['password']});assert code==200
code,overview=request(bundle['api_base_url'],'/v1/vessels/4/telemetry/overview',login['access_token']);assert code==200
record=next(r for r in overview['recordings'] if r['id']==sid)
assert record['state']=='ready' and record['expected_samples']==record['received_samples']==manifest['lastSequence']-manifest['firstSequence']+1
assert record['missing_samples']==record['rejected_samples']==0
sentinel=next(r for r in overview['recordings'] if r['id']=='f681eef9-928d-43bf-ace5-2206aa5d41b0')
assert sentinel['expected_samples']==sentinel['received_samples']==133 and sentinel['state']=='ready'
# Reconnect for normal recording-status exchange, with no new telemetry/Finish.
import time
try:
 code,connected=sk({'uploadMode':'automatic','confirmed':True,'expectedUploadMode':'local_only'});assert code==200
 for _ in range(20):
  code,current=sk();assert code==200
  if current['finishedTrip']['cloudStatus'] and not current['finishedTrip']['confirmationPending']:
   break
  time.sleep(1)
finally:
 code,off=sk({'uploadMode':'local_only','confirmed':True,'expectedUploadMode':'automatic'});assert code==200 and not off['liveTrackingEnabled']
code,after=sk();assert code==200 and not after['liveTrackingEnabled'] and after['trackingState']=='STOPPED'
assert after['finishedTrip']['cloudStatus']['id']==sid and after['finishedTrip']['cloudStatus']['state']=='ready' and not after['finishedTrip']['confirmationPending']
output={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'synthetic':True,'recordingId':sid,'beforeRetry':before,'retryHTTP':200,'sameManifest':True,'receiver':record,'sentinel':sentinel,'after':after,'boundaryAssertion':'pre-Finish GET queue can lag serialized final sample; Finish response exact durable lastSequence equals response queue.currentSequence'}
(ROOT/'docs/evidence/dev-feature-recording-reconciled.json').write_text(json.dumps(output,indent=2)+'\n')
print('PASS readback + one intentional same-ID retry; exact durable bounds/receiver completeness; terminal ready; sentinel133 preserved; OFF')
