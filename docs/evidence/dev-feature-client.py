"""Shared run-bound DEV client; login and endpoint helpers only. No fixture writes.
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
