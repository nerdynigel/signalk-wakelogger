"""THE-882: isolated DEV endpoint proof. Secrets stay in memory; no setup replay.
Run from the linked plugin worktree with the injected Paperclip run identity.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ['PAPERCLIP_API_URL'].rstrip('/').removesuffix('/api')
HEADERS = {'Authorization': 'Bearer ' + os.environ['PAPERCLIP_API_KEY']}

def pc(path, method='GET'):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=HEADERS, method=method), timeout=20) as response:
        return json.load(response)

def request(base, path, token=None, body=None, method=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, headers=headers, data=None if body is None else json.dumps(body).encode(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = {'error': 'non_json_error_response'}
        return error.code, result

def main():
    keys = {'ro': 'openclaw_scope_a_signalk_readonly_20261015111327', 'rw': 'openclaw_scope_a_signalk_readwrite_20261015111327', 'identity': 'wakelogger_scope_a_qa_identity_20261015111327'}
    granted = {entry['key'] for entry in pc('/api/agents/me/secrets')['secrets']}
    assert set(keys.values()) <= granted
    values = {name: pc('/api/agents/me/secrets/' + key + '/value', 'POST')['value'] for name, key in keys.items()}
    bundle = json.loads(values.pop('identity'))
    from urllib.parse import urlparse
    a, s = (urlparse(bundle[k]) for k in ['api_base_url', 'signalk_url'])
    assert a.scheme == s.scheme == 'http' and a.port == 8020 and s.port == 3002 and a.hostname == s.hostname
    def sk(path='/plugins/signalk-wakelogger/tracking', body=None, role='rw'):
        return request(bundle['signalk_url'], path, values[role] if role else None, body)
    code, login = request(bundle['api_base_url'], '/v1/auth/login', body={'email': bundle['email'], 'password': bundle['password']})
    assert code == 200
    token = login['access_token']
    def api(path):
        code, result = request(bundle['api_base_url'], path, token)
        assert code == 200
        return result
    assert api('/v1/auth/me')['id'] == 2
    vessels = api('/v1/vessels')
    assert any(v['id'] == 4 and v['owner_user_id'] == 2 for v in vessels)
    receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'userId': 2, 'vesselId': 4, 'cases': []}
    def status():
        code, result = sk(role='ro')
        assert code == 200
        return result
    def stable(result):
        return {key: result[key] for key in ['uploadMode', 'persistedUploadMode', 'liveTrackingEnabled', 'trackingSessionId', 'trackingState', 'finishedTrip', 'queue']}
    before = status()
    assert before['uploadMode'] == 'local_only' and not before['liveTrackingEnabled']
    assert before['queue']['currentSequence'] == before['queue']['acknowledgedSequence'] == 133
    sentinel = before['finishedTrip']['manifest']['id']
    assert sentinel == 'f681eef9-928d-43bf-ace5-2206aa5d41b0'
    receipt['before'] = stable(before)
    for name, role, path, body, expected in [
        ('anonymous-read-denied', None, '/plugins/signalk-wakelogger/tracking', None, 401),
        ('readonly-control-denied', 'ro', '/plugins/signalk-wakelogger/tracking', {'uploadMode': 'automatic'}, 401),
        ('invalid-mode', 'rw', '/plugins/signalk-wakelogger/tracking', {'uploadMode': 'invalid'}, 400),
        ('enable-unconfirmed', 'rw', '/plugins/signalk-wakelogger/tracking', {'uploadMode': 'automatic', 'expectedUploadMode': 'local_only'}, 400),
        ('enable-stale-mode', 'rw', '/plugins/signalk-wakelogger/tracking', {'uploadMode': 'automatic', 'confirmed': True, 'expectedUploadMode': 'automatic'}, 409),
        ('finish-readonly-denied', 'ro', '/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': 'bad'}, 401),
        ('finish-missing-id', 'rw', '/plugins/signalk-wakelogger/tracking/finish', {}, 400),
        ('finish-malformed-id', 'rw', '/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': 'bad'}, 400),
        ('finish-idle-unknown-id-noop', 'rw', '/plugins/signalk-wakelogger/tracking/finish', {'expectedRecordingId': '11111111-1111-4111-8111-111111111111'}, 200),
    ]:
        code, result = sk(path, body, role)
        assert code == expected, (name, code)
        assert stable(status()) == stable(before), name + ' changed state'
        receipt['cases'].append({'name': name, 'http': code, 'error': result.get('error'), 'preserved': True})
    # Byte checks use the actual served modules, not a rebuilt local page.
    receipt['servedHashes'] = {}
    for name in ['app.mjs', 'leg-eta.mjs', 'course-progress.mjs', 'instruments.mjs', 'tracking-controls.mjs']:
        with urllib.request.urlopen(bundle['signalk_url'] + '/signalk-wakelogger/' + name, timeout=20) as response:
            served = response.read()
        assert served == (ROOT / 'public' / name).read_bytes(), name
        receipt['servedHashes'][name] = hashlib.sha256(served).hexdigest()
    course = sk('/plugins/signalk-wakelogger/course', role='ro')[1]
    navigation = sk('/signalk/v1/api/vessels/self/navigation', role='ro')[1]
    receipt['nativeReadback'] = {'courseSelected': course['desired'] is not None, 'legStart': course['legStart'], 'position': navigation['position']['value'], 'positionTimestamp': navigation['position']['timestamp'], 'source': navigation['position']['$source']}
    assert course['desired'] is None and course['legStart'] is None
    overview = api('/v1/vessels/4/telemetry/overview')
    recording = next(r for r in overview['recordings'] if r['id'] == sentinel)
    assert recording['state'] == 'ready'
    assert recording['expected_samples'] == recording['received_samples'] == 133
    assert recording['missing_samples'] == recording['rejected_samples'] == 0
    receipt['sentinel'] = recording
    receipt['after'] = stable(status())
    assert receipt['after'] == receipt['before']
    output = ROOT / 'docs/evidence/dev-feature-endpoints.json'
    output.write_text(json.dumps(receipt, indent=2) + '\n')
    print('PASS', len(receipt['cases']), 'endpoint negatives; five served byte checks; sentinel133/133 and OFF preserved')

if __name__ == '__main__':
    main()
