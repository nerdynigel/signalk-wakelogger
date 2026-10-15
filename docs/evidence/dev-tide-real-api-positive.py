"""THE-882 positive real-API tide proof: voyage4 real fixture data captured from
the isolated API and rendered by the served website (desktop + mobile) with no
mocks. Read-only page render; receipts are single-use and host-sanitized.
"""
import datetime
import json
import os
import re
import runpy
import subprocess
from pathlib import Path

PLACEHOLDER = 'http://dev-web:3010'
sanitize = lambda value: re.sub(r'https?://[^/\s"\']+', PLACEHOLDER, str(value))

C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
ROOT, bundle, api, request = C['ROOT'], C['bundle'], C['api'], C['request']
receipt = ROOT / 'docs/evidence/dev-tide-real-api-positive.json'
pageReceipt = ROOT / 'docs/evidence/dev-tide-real-api-positive-page.json'
assert not receipt.exists() and not pageReceipt.exists(), 'single-use driver: receipts already exist'
R = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'endpoints': {}}

statusBefore = C['status']()
assert statusBefore['uploadMode'] == statusBefore['persistedUploadMode'] == 'local_only' and not statusBefore['liveTrackingEnabled']
recordingsBefore = api('/v1/vessels/4/telemetry/overview')['recordings']

voyage = api('/v1/voyages/4')
tideFields = ['tide_state', 'tide_height_m', 'tide_start_height_m', 'tide_end_height_m', 'tide_min_m', 'tide_max_m']
R['endpoints']['voyage4'] = {'tide': {key: voyage.get(key) for key in tideFields}, 'tide_events': voyage.get('tide_events') or []}
assert voyage.get('tide_state') and all(isinstance(voyage.get(key), (int, float)) for key in tideFields[1:]), 'voyage4 numeric tide fields missing'
assert len(R['endpoints']['voyage4']['tide_events']) >= 3, 'voyage4 tide events missing'
summary = api('/v1/voyages')
entries = summary if isinstance(summary, list) else summary.get('voyages', [])
entry = next((item for item in entries if item.get('id') == 4), None)
assert entry is not None, 'voyage4 missing from summary'
R['endpoints']['voyage4_summary'] = {'found': True, 'tide_events': len(entry.get('tide_events') or []), 'has_tide_fields': all(entry.get(key) is not None for key in tideFields[1:])}

code, recalc = request(bundle['api_base_url'], '/v1/race-plan/25/recalculate', C['token'], body={})
tide = (recalc or {}).get('tide_snapshot_json') if code == 200 else None
assert code == 200 and (tide or {}).get('source_type') == 'model' and len((tide or {}).get('events') or []) >= 3, 'plan25 tide snapshot not numeric'
R['endpoints']['recalculate'] = {'http': code, 'tide_source_type': tide.get('source_type'), 'source': tide.get('source'), 'tide_events': len(tide.get('events') or []), 'atlas': tide.get('atlas')}

heights = {f'{float(event["height_m"]):.2f} m' for event in R['endpoints']['voyage4']['tide_events']}
heights |= {f'{float(voyage["tide_start_height_m"]):.2f} m', f'{float(voyage["tide_end_height_m"]):.2f} m'}
diff = voyage['tide_end_height_m'] - voyage['tide_start_height_m']
expected = {'voyageCard': 'workspace-trip-card-4', 'heights': sorted(heights), 'diff': f'{diff:+.2f} m',
            'eventKinds': sorted({str(event['kind']).title() + ' Tide' for event in R['endpoints']['voyage4']['tide_events']})}
env = dict(os.environ)
env['PLAYWRIGHT_BROWSERS_PATH'] = '/home/nigel/.cache/ms-playwright'
url = bundle['frontend_url'] + '/vessels/manage?vessel=4&tab=trips'
browser = subprocess.run(['/home/nigel/.nvm/versions/node/v24.21.0/bin/node', 'docs/evidence/dev-tide-real-api-positive.cjs'],
                         input=json.dumps({'token': C['token'], 'url': url, 'expected': expected}),
                         text=True, cwd=ROOT, env=env, timeout=180, capture_output=True)
R['expected'] = expected
R['page'] = json.loads(sanitize(pageReceipt.read_text())) if pageReceipt.exists() else {'ok': False}
R['preserved'] = {
    'statusAfter': {key: C['status']()[key] for key in ['uploadMode', 'persistedUploadMode', 'liveTrackingEnabled', 'trackingSessionId']},
    'queueEqual': C['status']()['queue'] == statusBefore['queue'],
    'recordingsEqual': api('/v1/vessels/4/telemetry/overview')['recordings'] == recordingsBefore,
    'voyage4TideEqual': {key: api('/v1/voyages/4').get(key) for key in tideFields} == {key: voyage.get(key) for key in tideFields},
}
receipt.write_text(json.dumps(R, indent=2) + '\n')
assert R['preserved']['statusAfter']['uploadMode'] == 'local_only' and R['preserved']['queueEqual'] and R['preserved']['recordingsEqual'] and R['preserved']['voyage4TideEqual']
assert browser.returncode == 0 and R['page'].get('ok'), 'positive real-API served tide check failed: ' + sanitize(browser.stderr or '')[-400:]
print('PASS real-API positive tide:', R['endpoints']['voyage4']['tide'], '| events', len(R['endpoints']['voyage4']['tide_events']),
      '| recalc', R['endpoints']['recalculate']['tide_source_type'], R['endpoints']['recalculate']['tide_events'],
      '| expected', expected)
for view in R['page']['viewports']:
    print('  ', view['viewport'], view['tideText'][:160])
