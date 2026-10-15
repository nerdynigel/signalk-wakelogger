"""Close only the known ETA fixture recording once; preserve all data and OFF.
Do not rerun after an uncertain Finish; reconcile the saved receipt instead.
"""
import json, runpy, time, datetime
from pathlib import Path
C=runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
ROOT,status,sk,mode,api=(C[k] for k in ['ROOT','status','sk','mode','api'])
output=ROOT/'docs/evidence/dev-feature-cleanup.json'
assert not output.exists(), 'read saved cleanup; do not replay'
s=status();sid=s['trackingSessionId'];assert sid=='b472b1af-6aeb-4861-8f6e-5c87d557cec8' and s['uploadMode']=='local_only'
R={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'before':s}
def save():output.write_text(json.dumps(R,indent=2)+'\n')
save()
try:
 R['on']=mode('automatic');save()
 code,result=sk('/plugins/signalk-wakelogger/tracking/finish',{'expectedRecordingId':sid});R['finishHTTP']=code;R['finish']=result;save();assert code==200
 for _ in range(15):
  overview=api('/v1/vessels/4/telemetry/overview');r=next((r for r in overview['recordings'] if r['id']==sid),None)
  if r and r['state']=='ready':break
  time.sleep(1)
 R['receiver']=r;save();assert r and r['state']=='ready' and r['expected_samples']==r['received_samples'] and r['missing_samples']==r['rejected_samples']==0
 R['originalSentinel']=next(r for r in overview['recordings'] if r['id']=='f681eef9-928d-43bf-ace5-2206aa5d41b0');save()
finally:
 R['finalOff']=mode('local_only');save()
 assert not R['finalOff']['liveTrackingEnabled'] and R['finalOff']['trackingSessionId'] is None
print('PASS ETA fixture closed; receiver complete; original sentinel retained; final OFF; no deletion/reset')
