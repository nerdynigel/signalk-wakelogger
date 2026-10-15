"""One NEW synthetic recording through native WS and Finish/internal receiver.
Never replays setup/pairing or Finish on the preserved THE-903 sentinel.
"""
import datetime
import json
from pathlib import Path
import runpy
import subprocess
import time
common = runpy.run_path(str(Path(__file__).with_name('dev-feature-endpoints.py')))
pc, request, ROOT = (common[k] for k in ['pc', 'request', 'ROOT'])
keys = {'ro': 'openclaw_scope_a_signalk_readonly_20261015111327', 'rw': 'openclaw_scope_a_signalk_readwrite_20261015111327', 'identity': 'wakelogger_scope_a_qa_identity_20261015111327'}
assert set(keys.values()) <= {e['key'] for e in pc('/api/agents/me/secrets')['secrets']}
values = {k: pc('/api/agents/me/secrets/' + v + '/value', 'POST')['value'] for k, v in keys.items()}
bundle = json.loads(values.pop('identity'))
from urllib.parse import urlparse
a, s = (urlparse(bundle[k]) for k in ['api_base_url', 'signalk_url'])
assert a.scheme == s.scheme == 'http' and a.port == 8020 and s.port == 3002 and a.hostname == s.hostname
code, login = request(bundle['api_base_url'], '/v1/auth/login', body={'email': bundle['email'], 'password': bundle['password']})
assert code == 200
token = login['access_token']
def api(path):
    code, result = request(bundle['api_base_url'], path, token)
    assert code == 200
    return result
assert api('/v1/auth/me')['id'] == 2

def sk(path='/plugins/signalk-wakelogger/tracking', body=None):
    return request(bundle['signalk_url'], path, values['rw'], body)
def status():
    code, result = sk()
    assert code == 200
    return result
def mode(value):
    before = status()
    code, result = sk(body={'uploadMode': value, 'confirmed': True, 'expectedUploadMode': before['uploadMode']})
    assert code == 200 and result['uploadMode'] == value and result['persistedUploadMode'] == value
    return result
R = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'source': 'THE882.synthetic.feature-proof', 'cases': []}
R['before'] = status()
assert R['before']['uploadMode'] == 'local_only' and R['before']['trackingSessionId'] is None
assert R['before']['queue']['currentSequence'] == R['before']['queue']['acknowledgedSequence'] == 133
sentinel = next(r for r in api('/v1/vessels/4/telemetry/overview')['recordings'] if r['id'] == 'f681eef9-928d-43bf-ace5-2206aa5d41b0')
# Native entry uses the public authenticated WS endpoint, never a model handler.
js = r"""const fs=require('fs');const WebSocket=require('ws');const q=JSON.parse(fs.readFileSync(0,'utf8'));let n=0,timer;const ws=new WebSocket(q.url,{headers:{Authorization:'Bearer '+q.token}});const end=setTimeout(()=>{clearInterval(timer);ws.close();setTimeout(()=>process.exit(0),300)},136000);ws.on('open',()=>{timer=setInterval(()=>{ws.send(JSON.stringify({context:'vessels.self',updates:[{$source:'THE882.synthetic.feature-proof',timestamp:new Date().toISOString(),values:[{path:'navigation.position',value:{latitude:-33.85536-n*.00004,longitude:151.20268+n*.00002}},{path:'navigation.speedOverGround',value:2.6},{path:'navigation.courseOverGroundTrue',value:1.1},{path:'navigation.headingTrue',value:1.1},{path:'environment.wind.speedApparent',value:5.5},{path:'environment.wind.angleApparent',value:.7}]}]}));n++},1000)});ws.on('error',()=>{clearTimeout(end);clearInterval(timer);console.error('native WS failed');process.exit(1)});"""
p = None
try:
    R['enabled'] = mode('automatic')
    p = subprocess.Popen(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node', '-e', js], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write(json.dumps({'url': bundle['signalk_url'].replace('http:', 'ws:') + '/signalk/v1/stream?subscribe=none', 'token': values['rw']}));p.stdin.close()
    # Bounded state convergence while native samples establish a real recording.
    for _ in range(50):
        active = status()
        if active['trackingSessionId']:
            break
        time.sleep(1)
    assert active['trackingSessionId'], 'no recording after 50s'
    sid = active['trackingSessionId'];R['recordingId'] = sid;R['active'] = active
    assert sid != sentinel['id']
    code, result = sk('/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': '11111111-1111-4111-8111-111111111111'})
    assert code == 409 and result['error'] == 'recording_changed' and status()['trackingSessionId'] == sid
    R['cases'].append({'name': 'active-finish-identity-conflict', 'http': code, 'preservedRecording': sid})
    code, result = sk(body={'uploadMode': 'local_only', 'expectedUploadMode': 'automatic'})
    assert code == 400 and status()['uploadMode'] == 'automatic'
    R['cases'].append({'name': 'disable-unconfirmed-preserves-ON', 'http': code})
    R['offDuringRecording'] = mode('local_only')
    assert R['offDuringRecording']['trackingSessionId'] == sid
    R['onAfterReconnect'] = mode('automatic')
    assert R['onAfterReconnect']['trackingSessionId'] == sid
    print('native input active; conflict and both-direction confirmation checks PASS', flush=True)
    assert p.wait(timeout=145) == 0, 'native WS failed'
    R['beforeFinish'] = status()
    assert R['beforeFinish']['trackingSessionId'] == sid
    code, result = sk('/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': sid})
    assert code == 200
    R['finish'] = result
    manifest = result['finishedTrip']['manifest']
    assert manifest['id'] == sid and manifest['state'] == 'complete'
    assert manifest['lastSequence'] >= R['beforeFinish']['queue']['currentSequence']
    assert manifest['lastSequence'] == result['queue']['currentSequence']
    # This intentional same-ID retry tests idempotence on the NEW recording only.
    code, repeated = sk('/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': sid})
    assert code == 200 and repeated['finishedTrip']['manifest'] == manifest
    R['idempotentRetry'] = {'http': code, 'sameManifest': True}
    for _ in range(40):
        overview = api('/v1/vessels/4/telemetry/overview')
        matches = [r for r in overview['recordings'] if r['id'] == sid]
        if matches and matches[0]['state'] == 'ready' and status()['finishedTrip'].get('confirmationPending') is False:
            break
        time.sleep(2)
    assert matches and matches[0]['state'] == 'ready', 'receiver recording not ready'
    recording = matches[0]
    assert recording['received_samples'] == recording['expected_samples'] == manifest['lastSequence'] - manifest['firstSequence'] + 1
    assert recording['missing_samples'] == recording['rejected_samples'] == 0
    R['receiver'] = recording
    R['sentinelPreserved'] = next(r for r in overview['recordings'] if r['id'] == sentinel['id']) == sentinel
    assert R['sentinelPreserved']
finally:
    if p and p.poll() is None:
        p.terminate();p.wait(timeout=10)
    R['finalOff'] = mode('local_only')
    assert not R['finalOff']['liveTrackingEnabled']
    R['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (ROOT / 'docs/evidence/dev-feature-recording.json').write_text(json.dumps(R, indent=2) + '\n')
print('PASS new native recording Finish/internal receiver, same-ID retry, original sentinel preserved, final OFF', flush=True)
