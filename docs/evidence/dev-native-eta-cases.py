"""THE-882 remaining native ETA cases on the isolated DEV fixture.
Real native WS telemetry, actual served plugin modules and actual endpoint
readback. Synthetic DEV only; reuses route4/plan25 and never replays
recording creation. Preserves tracking OFF and every recording.
"""
import datetime
import json
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
import runpy

C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
request, api, sk, status, bundle, values = (C[k] for k in ['request', 'api', 'sk', 'status', 'bundle', 'values'])
ROOT = C['ROOT']
NODE = '/home/nigel/.nvm/versions/node/v24.21.0/bin/node'
SOURCE = 'THE882.synthetic.eta'
receiptPath = ROOT / 'docs/evidence/dev-native-eta-cases.json'
R = json.loads(receiptPath.read_text()) if receiptPath.exists() else {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True, 'observations': []}
assert not R.get('observations'), 'single-use driver: do not replay completed observations'
prior = json.loads((ROOT / 'docs/evidence/dev-native-eta.json').read_text())
# The continuity baseline chains documented resets: pre-restart marker, then any
# explicit re-activation already captured by a disclosed earlier attempt.
continuity = prior['marker']
continuitySource = 'dev-native-eta.json pre-restart marker'
for path in sorted((ROOT / 'docs/evidence').glob('dev-native-eta-cases-attempt*.json'), reverse=True):
    data = json.loads(path.read_text())
    resetAfter = (data.get('reset') or {}).get('after')
    if resetAfter:
        continuity = resetAfter
        continuitySource = path.name + ' activated baseline'
        break

def save():
    receiptPath.write_text(json.dumps(R, indent=2) + '\n')

def evaluate(directory, course, nav, plan):
    code, race = sk('/plugins/signalk-wakelogger/race-plan')
    assert code == 200
    now = int(time.time() * 1000)
    script = "import fs from 'node:fs';import {raceProgress} from './course-progress.mjs';const q=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(raceProgress(q.course,q.nav,{},null,q.plan,q.now)))"
    result = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e', script], cwd=directory, input=json.dumps({'course': course, 'nav': nav, 'plan': race, 'now': now}), text=True))
    return now, race, result

def readback():
    code, course = sk('/plugins/signalk-wakelogger/course')
    assert code == 200
    code, nav = sk('/signalk/v1/api/vessels/self/navigation')
    assert code == 200
    return course, nav

def observe(directory, name, course, nav, note=None):
    now, race, result = evaluate(directory, course, nav, None)
    marker = course.get('legStart') or {}
    observation = {'case': name, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'nowMs': now,
                   'marker': marker, 'ageSeconds': (now - marker['startedAt']) / 1000 if marker.get('startedAt') else None,
                   'position': nav['position']['value'], 'positionTimestamp': nav['position'].get('timestamp'),
                   'sog': nav['speedOverGround'].get('value'), 'sogTimestamp': nav['speedOverGround'].get('timestamp'),
                   'cogTimestamp': nav['courseOverGroundTrue'].get('timestamp'),
                   'result': result, 'note': note}
    R['observations'].append(observation)
    save()
    print(name, json.dumps({k: result.get(k) for k in ['vmgKn', 'timeToGo', 'eta', 'etaReason', 'etaProvisional']}))
    return observation

def phase(_directory, fields, startM, endM, seconds, lat, lon0):
    payload = {'url': bundle['signalk_url'].replace('http:', 'ws:') + '/signalk/v1/stream?subscribe=none', 'token': values['rw'],
               'lat': lat, 'lon0': lon0, 'startM': startM, 'endM': endM, 'durationMs': seconds * 1000, 'fields': fields, 'source': SOURCE}
    script = r"""const fs=require('fs'),WebSocket=require('ws');const q=JSON.parse(fs.readFileSync(0,'utf8'));
let timer;const ws=new WebSocket(q.url,{headers:{Authorization:'Bearer '+q.token}});
const R=6371000,rad=d=>d*Math.PI/180;
const end=setTimeout(()=>{clearInterval(timer);ws.close();setTimeout(()=>process.exit(0),300)},q.durationMs);
ws.on('open',()=>{const t0=Date.now();timer=setInterval(()=>{const frac=Math.min(1,(Date.now()-t0)/q.durationMs);const m=q.startM+(q.endM-q.startM)*frac;
const lon=q.lon0+m/(R*Math.cos(rad(q.lat)))*180/Math.PI;const v=[];
if(q.fields.includes('p'))v.push({path:'navigation.position',value:{latitude:q.lat,longitude:lon}});
if(q.fields.includes('x'))v.push({path:'navigation.position',value:{latitude:95,longitude:lon}});
if(q.fields.includes('s'))v.push({path:'navigation.speedOverGround',value:0});
if(q.fields.includes('c'))v.push({path:'navigation.courseOverGroundTrue',value:Math.PI/2});
ws.send(JSON.stringify({context:'vessels.self',updates:[{$source:q.source,timestamp:new Date().toISOString(),values:v}]}))},800)});
ws.on('error',()=>{clearTimeout(end);clearInterval(timer);process.exit(1)});"""
    process = subprocess.Popen([NODE, '-e', script], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    process.stdin.write(json.dumps(payload))
    process.stdin.close()
    return process

def finish(process, timeout=20):
    code = process.wait(timeout=timeout)
    if code != 0:
        raise AssertionError('injection process failed: ' + (process.stderr.read() or '')[:500])

def valid_position(position):
    return position and abs(position.get('latitude', 91)) <= 90 and abs(position.get('longitude', 181)) <= 180

# Mirrors public/leg-eta.mjs alongLegMeters for an independent expected value.
import math
def polar(a, b):
    r = math.radians
    x, y, d = r(a['latitude']), r(b['latitude']), r(b['longitude'] - a['longitude'])
    h = math.sin((y - x) / 2) ** 2 + math.cos(x) * math.cos(y) * math.sin(d / 2) ** 2
    return 2 * math.atan2(math.sqrt(min(1, h)), math.sqrt(max(0, 1 - h))), math.atan2(math.sin(d) * math.cos(y), math.cos(x) * math.sin(y) - math.sin(x) * math.cos(y) * math.cos(d))
def along(origin, target, position):
    axis, p = polar(origin, target), polar(origin, position)
    return 6371000 * math.atan2(math.sin(p[0]) * math.cos(p[1] - axis[1]), math.cos(p[0]))

def expected_vmg(origin, marker, position, now):
    initial = along(origin, position['target'], marker['position'])
    current = along(origin, position['target'], position['current'])
    elapsed = (now - marker['startedAt']) / 3600000
    return (current - initial) / 1852 / elapsed, initial, current

def main():
    before = status()
    assert before['uploadMode'] == 'local_only' and not before['liveTrackingEnabled'], 'tracking not OFF/local-only'
    # Injected synthetic movement crossed the trip-start distance threshold and the
    # plugin began a LOCAL synthetic recording. It is preserved, never uploaded here.
    R['trackingBefore'] = {k: before[k] for k in ['uploadMode', 'trackingSessionId', 'trackingState']}
    R['syntheticRecordingStartedByInjection'] = before['trackingSessionId']
    course, nav = readback()
    # Restart/activation-boundary continuity: the leg marker preserved in the
    # latest disclosed baseline survived every isolated Signal K restart since
    # (dev-reliability-recovery-20261015.md) and the leg average below continues
    # from that startedAt until this run's own explicit re-activation.
    assert course['legStart']['identity'] == continuity['identity'], 'marker identity changed since baseline'
    assert course['legStart']['startedAt'] == continuity['startedAt'], 'marker startedAt changed since baseline'
    assert course['legStart']['position'] == continuity['position'], 'marker baseline position changed'
    R['restartBoundary'] = {'baseline': continuity, 'source': continuitySource, 'currentMarker': course['legStart'], 'preservedAcrossIsolatedSignalKRestarts': True}
    save()
    # Controlled injected core of the leg-average baseline.
    baseline = course['legStart']['position']
    lat, lon0 = baseline['latitude'], baseline['longitude']
    with tempfile.TemporaryDirectory(prefix='the882-served-cases-') as directory:
        directoryPath = Path(directory)
        for name in ['leg-eta.mjs', 'course-progress.mjs', 'instruments.mjs', 'wind-derivation.mjs']:
            with urllib.request.urlopen(bundle['signalk_url'] + '/signalk-wakelogger/' + name, timeout=20) as response:
                data = response.read()
            assert data == (ROOT / 'public' / name).read_bytes(), name
            (directoryPath / name).write_bytes(data)
        # Preflight: prove the injected source is the actual native input before long phases.
        p = phase(directory, 'psc', 0, 3, 4, lat, lon0)
        finish(p)
        time.sleep(1)
        _, navP = readback()
        assert navP['position'].get('$source') == SOURCE, navP['position'].get('$source')
        assert navP['position'].get('timestamp'), 'missing native position timestamp'
        R['preflight'] = {'source': SOURCE, 'position': navP['position']['value'], 'timestamp': navP['position']['timestamp']}
        save()
        # Phase A: continuous unchanged-leg updates, eastbound 1 m/s, unequal observation gaps.
        p = phase(directory, 'psc', 0, 95, 75, lat, lon0)
        time.sleep(8)
        courseA, navA = readback()
        one = observe(directory, 'continuous-average-early', courseA, navA)
        time.sleep(53)
        courseA, navA = readback()
        two = observe(directory, 'continuous-average-mid', courseA, navA)
        time.sleep(10)
        courseA, navA = readback()
        three = observe(directory, 'continuous-average-late', courseA, navA)
        finish(p, timeout=25)
        assert courseA['legStart']['identity'] == continuity['identity'] and courseA['legStart']['startedAt'] == continuity['startedAt'], 'unchanged leg marker moved during continuous updates'
        for observation in [one, two, three]:
            result = observation['result']
            assert result['vmgKn'] > 0 and not result['etaProvisional'], (observation['case'], result.get('etaReason'))
            origin = {'latitude': observation['result']['previous']['latitude'], 'longitude': observation['result']['previous']['longitude']}
            # Independent recomputation mirroring public/leg-eta.mjs projection semantics.
            ev, _, _ = expected_vmg(origin, courseA['legStart'], {'target': observation['result']['next'], 'current': observation['position']}, observation['nowMs'])
            assert abs(result['vmgKn'] - ev) < 1e-9, (observation['case'], result['vmgKn'], ev)
            # Average over the leg, never the instantaneous SOG (injected SOG is 0).
            assert 0 < ev < 30, observation['case']
            limit = result['distanceNm'] / result['vmgKn'] * 3600
            if limit > 86400:
                assert result['eta'] is None and result['etaReason'] == 'ETA outside live horizon', observation['case']
            else:
                assert result['eta'] and result['etaReason'] is None, observation['case']
                assert abs(result['timeToGo'] - limit) < 1e-6, observation['case']
        assert one['result']['vmgKn'] != two['result']['vmgKn'] != three['result']['vmgKn'], 'stale average'
        R['continuous'] = {'observations': [o['case'] for o in [one, two, three]], 'gapSeconds': [one['ageSeconds'], two['ageSeconds'], three['ageSeconds']]}
        save()
        # Phase B: skew - position fresh, SOG/COG frozen for >10 s but below 30 s.
        p = phase(directory, 'p', 95, 110, 15, lat, lon0)
        time.sleep(13)
        courseB, navB = readback()
        skew = observe(directory, 'out-of-sync-inputs', courseB, navB)
        finish(p)
        assert skew['result']['eta'] is None and skew['result']['vmgKn'] is None, skew['result']
        assert skew['result']['etaReason'] == 'Navigation inputs out of sync', skew['result']['etaReason']
        # Phase C: stale - no updates at all until every input exceeds 30 s.
        time.sleep(36)
        courseC, navC = readback()
        stale = observe(directory, 'stale-inputs', courseC, navC)
        assert stale['result']['eta'] is None and stale['result']['etaReason'] == 'Fresh navigation inputs unavailable', stale['result']
        p = phase(directory, 'psc', 110, 135, 27, lat, lon0)
        time.sleep(22)
        courseR, navR = readback()
        recovered = observe(directory, 'recovery-after-stale', courseR, navR)
        finish(p)
        assert recovered['result']['eta'] and recovered['result']['vmgKn'] > 0, recovered['result']
        # Phase D: explicit re-activation resets the leg baseline (reset boundary).
        code, activated = sk('/plugins/signalk-wakelogger/course/activate', {})
        assert code == 200, (code, activated)
        # Fresh native samples after the reset so positionTime exceeds startedAt.
        pD = phase(directory, 'psc', 135, 140, 6, lat, lon0)
        time.sleep(3)
        courseD, navD = readback()
        assert courseD['legStart']['startedAt'] > continuity['startedAt'], 'activation did not reset the leg marker'
        R['reset'] = {'before': continuity, 'after': courseD['legStart'], 'activation': {'http': code, 'activation': activated.get('activation')}}
        save()
        early = observe(directory, 'reset-provisional-suppression', courseD, navD)
        assert early['result']['eta'] is None and early['result']['vmgKn'] is None, early['result']
        assert early['result']['etaReason'] == 'Collecting leg average; plan speed unavailable', early['result']['etaReason']
        finish(pD)
        # Phase E: sustained backing away from the mark makes the signed leg average negative.
        p = phase(directory, 'psc', 140, 70, 60, lat, lon0)
        finish(p, timeout=70)
        time.sleep(2)
        courseE, navE = readback()
        negative = observe(directory, 'nonpositive-leg-average', courseE, navE)
        assert negative['ageSeconds'] > 60, negative['ageSeconds']
        assert negative['result']['eta'] is None and negative['result']['vmgKn'] is not None and negative['result']['vmgKn'] <= 0, negative['result']
        assert negative['result']['etaReason'] == 'No positive leg progress', negative['result']['etaReason']
        # Phase F: recovery returns to positive average without rebasing.
        p = phase(directory, 'psc', 70, 190, 40, lat, lon0)
        finish(p, timeout=50)
        time.sleep(2)
        courseF, navF = readback()
        recovered2 = observe(directory, 'recovery-after-negative', courseF, navF)
        assert courseF['legStart']['startedAt'] == courseD['legStart']['startedAt'], 'recovery rebased the leg'
        assert recovered2['result']['eta'] and recovered2['result']['vmgKn'] > 0 and not recovered2['result']['etaProvisional'], recovered2['result']
        origin = {'latitude': recovered2['result']['previous']['latitude'], 'longitude': recovered2['result']['previous']['longitude']}
        ev2, _, _ = expected_vmg(origin, courseF['legStart'], {'target': recovered2['result']['next'], 'current': recovered2['position']}, recovered2['nowMs'])
        assert abs(recovered2['result']['vmgKn'] - ev2) < 1e-9, (recovered2['result']['vmgKn'], ev2)
        # Phase G: invalid native position (Signal K decides whether to store it).
        p = phase(directory, 'x', 190, 190, 6, lat, lon0)
        finish(p)
        time.sleep(1)
        courseG, navG = readback()
        R['invalidStored'] = {'position': navG['position']['value'], 'stored': not valid_position(navG['position']['value'])}
        invalid = observe(directory, 'invalid-position', courseG, navG, 'Signal K acceptance is authoritative')
        if not valid_position(navG['position']['value']):
            assert invalid['result']['eta'] is None and invalid['result']['etaReason'] == 'Navigation inputs unavailable', invalid['result']
        p = phase(directory, 'psc', 190, 230, 40, lat, lon0)
        finish(p, timeout=50)
        time.sleep(2)
        courseH, navH = readback()
        final = observe(directory, 'recovery-after-invalid', courseH, navH)
        assert valid_position(navH['position']['value']) and final['result']['eta'] and final['result']['vmgKn'] > 0, final['result']
        R['finalMarker'] = courseH['legStart']
    after = status()
    assert after['uploadMode'] == 'local_only' and not after['liveTrackingEnabled'], 'tracking changed'
    assert after['queue']['acknowledgedSequence'] == before['queue']['acknowledgedSequence'], 'upload acknowledged during ETA proof'
    assert after['queue']['currentSequence'] >= before['queue']['currentSequence'], 'queue rewound'
    R['trackingAfter'] = {k: after[k] for k in ['uploadMode', 'trackingSessionId', 'trackingState']}
    R['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    print('PASS native provisional-transition/reset/unequal/skew/stale/nonpositive/invalid/recovery on actual served modules; marker reset event recorded; tracking OFF preserved')

if __name__ == '__main__':
    main()
