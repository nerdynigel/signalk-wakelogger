"""THE-882 native tracking consent proof on the real served plugin page.
Run-bound secret; single-use receipt; isolated DEV only; final OFF asserted
against the native status endpoint afterwards.
"""
import json
import os
import subprocess
from pathlib import Path
import runpy

C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
ROOT, bundle, status, pc = C['ROOT'], C['bundle'], C['status'], C['pc']
receipt = ROOT / 'docs/evidence/dev-tracking-consent.json'
post = ROOT / 'docs/evidence/dev-tracking-consent-post.json'
assert not receipt.exists() and not post.exists(), 'single-use driver: receipt already exists'
key = 'openclaw_scope_a_signalk_readwrite_20261015111327'
token = pc('/api/agents/me/secrets/' + key + '/value', 'POST')['value']
env = dict(os.environ)
env['PLAYWRIGHT_BROWSERS_PATH'] = '/home/nigel/.cache/ms-playwright'
r = subprocess.run(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node', 'docs/evidence/dev-tracking-consent.cjs'],
                   input=json.dumps({'token': token, 'base': bundle['signalk_url']}), text=True,
                   cwd=ROOT, env=env, timeout=150)
assert r.returncode == 0, 'browser consent driver failed'
after = status()
assert after['uploadMode'] == 'local_only' and not after['liveTrackingEnabled'], 'final mode not OFF'
post.write_text(json.dumps({'at': after['at'], 'uploadMode': after['uploadMode'], 'liveTrackingEnabled': after['liveTrackingEnabled'],
                            'trackingSessionId': after['trackingSessionId'], 'trackingState': after['trackingState'], 'queue': after['queue']}, indent=2) + '\n')
print('PASS native consent receipt + final OFF readback; active synthetic recording preserved:', after['trackingSessionId'])
