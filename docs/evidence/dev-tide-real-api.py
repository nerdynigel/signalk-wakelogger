"""THE-882 real isolated-API tide coverage: exact endpoint receipts plus the
served website rendered against the real API (no mocks). Single-use receipts;
no fixture writes beyond the two documented probes.
"""
import json
import os
import re
import subprocess
from pathlib import Path
import runpy

import datetime

# Persisted receipts must never carry the real DEV host address.
PLACEHOLDER = 'http://dev-web:3010'
sanitize = lambda value: re.sub(r'https?://[^/\s"\']+', PLACEHOLDER, str(value))

C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
ROOT, bundle, api, request, pc = C['ROOT'], C['bundle'], C['api'], C['request'], C['pc']
R = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'endpoints': {}}
receipt = ROOT / 'docs/evidence/dev-tide-real-api.json'
pageReceipt = ROOT / 'docs/evidence/dev-tide-real-api-page.json'
assert not receipt.exists() and not pageReceipt.exists(), 'single-use driver: receipts already exist'

voyage = api('/v1/voyages/4')
R['endpoints']['voyage4'] = {'keys': sorted(voyage.keys()), 'tide_events': len(voyage.get('tide_events') or []),
                             'race_plan_id': voyage.get('race_plan_id'), 'status': voyage.get('status')}
summary = api('/v1/voyages')
entries = summary if isinstance(summary, list) else summary.get('voyages', [])
voyageSummary = next((item for item in entries if item.get('id') == 4), None)
R['endpoints']['voyage4_summary'] = {'found': voyageSummary is not None,
                                     'tide_events': len((voyageSummary or {}).get('tide_events') or []),
                                     'has_race_plan_snapshot': bool((voyageSummary or {}).get('race_plan_snapshot'))}

code, backfill = request(bundle['api_base_url'], '/v1/voyages/4/environment-snapshots/backfill', C['token'], body={})
R['endpoints']['backfill'] = {'http': code, 'body': str(backfill)[:200]}
code, fetch = request(bundle['api_base_url'], '/v1/voyages/4/environment-snapshots/fetch', C['token'], body={})
R['endpoints']['fetch'] = {'http': code, 'body': str(fetch)[:200]}
code, recalc = request(bundle['api_base_url'], '/v1/race-plan/25/recalculate', C['token'], body={})
tide = ((recalc or {}).get('calculation_snapshot_json') or recalc or {}).get('tide_snapshot_json') if code == 200 else None
R['endpoints']['recalculate'] = {'http': code, 'tide_source_type': (tide or {}).get('source_type'), 'tide_events': len((tide or {}).get('events') or [])}

token = C['token']
env = dict(os.environ)
env['PLAYWRIGHT_BROWSERS_PATH'] = '/home/nigel/.cache/ms-playwright'
url = bundle['frontend_url'] + '/vessels/manage?vessel=4&tab=trips'
browser = subprocess.run(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node', 'docs/evidence/dev-tide-real-api.cjs'],
                         input=json.dumps({'token': token, 'url': url}), text=True, cwd=ROOT, env=env, timeout=120)
R['page'] = json.loads(sanitize(pageReceipt.read_text())) if pageReceipt.exists() else {'ok': False}
receipt.write_text(json.dumps(R, indent=2) + '\n')
assert browser.returncode == 0 and R['page'].get('ok'), 'real-API served website tide check failed'
print('PASS real API tide receipt: provider backfill/fetch', R['endpoints']['backfill']['http'], R['endpoints']['fetch']['http'],
      '| recalc tide', R['endpoints']['recalculate']['tide_source_type'], '| website no-tide state', R['page']['missingText'])
