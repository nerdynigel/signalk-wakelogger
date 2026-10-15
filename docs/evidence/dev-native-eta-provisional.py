"""THE-882 numeric provisional plan-speed ETA proof on the isolated DEV fixture.

Applies Chief's recorded conditional decision (comment 77fa4eeb): one fresh
isolation proof (dev-isolation-proof.json, same run), then a bounded, recorded
automatic-mode receive interval so the frozen plugin's MQTT transport receives
the staged Race Pack revision3, then final persisted OFF. Natural ACK/queue
progress to the isolated receiver is recorded, never rewound. Synthetic DEV
only; every recording, the voyage and the leg marker data are preserved.
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
request, api, sk, status, mode, bundle, values = (C[k] for k in ['request', 'api', 'sk', 'status', 'mode', 'bundle', 'values'])
ROOT = C['ROOT']
NODE = '/home/nigel/.nvm/versions/node/v24.21.0/bin/node'
SOURCE = 'THE882.synthetic.eta'
receiptPath = ROOT / 'docs/evidence/dev-native-eta-provisional.json'
assert not receiptPath.exists(), 'single-use driver: receipt already exists'
isolation = json.loads((ROOT / 'docs/evidence/dev-isolation-proof.json').read_text())
R = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True,
     'isolationFreshness': isolation['at'], 'observations': []}

def save():
    receiptPath.write_text(json.dumps(R, indent=2) + '\n')

def evaluate(directory, course, nav):
    code, race = sk('/plugins/signalk-wakelogger/race-plan')
    assert code == 200
    now = int(time.time() * 1000)
    script = "import fs from 'node:fs';import {raceProgress} from './course-progress.mjs';const q=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(raceProgress(q.course,q.nav,{},null,q.plan,q.now)))"
    result = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e', script], cwd=directory,
                                                input=json.dumps({'course': course, 'nav': nav, 'plan': race, 'now': now}), text=True))
    return now, race, result

def readback():
    code, course = sk('/plugins/signalk-wakelogger/course')
    assert code == 200
    code, nav = sk('/signalk/v1/api/vessels/self/navigation')
    assert code == 200 and isinstance(nav, dict) and nav.get('position'), (code, nav)
    return course, nav

def observe(directory, name, note=None):
    course, nav = readback()
    now, race, result = evaluate(directory, course, nav)
    marker = course.get('legStart') or {}
    observation = {'case': name, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'nowMs': now,
                   'marker': marker, 'ageSeconds': (now - marker['startedAt']) / 1000 if marker.get('startedAt') else None,
                   'position': nav['position']['value'], 'positionTimestamp': nav['position'].get('timestamp'),
                   'sog': nav['speedOverGround'].get('value'), 'sogTimestamp': nav['speedOverGround'].get('timestamp'),
                   'cogTimestamp': nav['courseOverGroundTrue'].get('timestamp'),
                   'pack': race.get('pack'), 'snapshotRevision': (race.get('latestSnapshot') or {}).get('packRevision'),
                   'result': result, 'note': note}
    R['observations'].append(observation)
    save()
    print(name, json.dumps({k: result.get(k) for k in ['vmgKn', 'timeToGo', 'eta', 'etaReason', 'etaProvisional']}))
    return observation

def phase(fields, startM, endM, seconds, lat, lon0):
    payload = {'url': bundle['signalk_url'].replace('http:', 'ws:') + '/signalk/v1/stream?subscribe=none', 'token': values['rw'],
               'lat': lat, 'lon0': lon0, 'startM': startM, 'endM': endM, 'durationMs': seconds * 1000, 'fields': fields, 'source': SOURCE}
    script = r"""const fs=require('fs'),WebSocket=require('ws');const q=JSON.parse(fs.readFileSync(0,'utf8'));
let timer;const ws=new WebSocket(q.url,{headers:{Authorization:'Bearer '+q.token}});
const R=6371000,rad=d=>d*Math.PI/180;
const end=setTimeout(()=>{clearInterval(timer);ws.close();setTimeout(()=>process.exit(0),300)},q.durationMs);
ws.on('open',()=>{const t0=Date.now();timer=setInterval(()=>{const frac=Math.min(1,(Date.now()-t0)/q.durationMs);const m=q.startM+(q.endM-q.startM)*frac;
const lon=q.lon0+m/(R*Math.cos(rad(q.lat)))*180/Math.PI;const v=[];
if(q.fields.includes('p'))v.push({path:'navigation.position',value:{latitude:q.lat,longitude:lon}});
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

def main():
    before = status()
    assert before['uploadMode'] == 'local_only' and not before['liveTrackingEnabled'] and before['persistedUploadMode'] == 'local_only'
    assert before['trackingSessionId'] == 'b3f7305e-4baa-435b-b2ba-43ff15260bcc'
    assert before['queue']['acknowledgedSequence'] == 647 and before['queue']['currentSequence'] == 1440 and before['queue']['droppedCount'] == 0
    assert before['historicalUpload']['remainingSamples'] == 792
    R['trackingBefore'] = {'uploadMode': before['uploadMode'], 'trackingSessionId': before['trackingSessionId'],
                           'trackingState': before['trackingState'], 'queue': before['queue'], 'historicalUpload': before['historicalUpload'],
                           'progressionDisclosure': 'one synthetic fixture-prep sample captured (currentSequence 1439->1440) when a preparation probe published a synthetic navigation value after the isolation proof; no purge, reset, rewind or reinsertion; acknowledgedSequence and historicalUpload unchanged'}
    save()
    expectedPack = {'revision': 3, 'sha256': '0e9a9dbd48bf41468dbf3969b43bbbca08a4fae4d1d6c6ead23b5d3750e9bcb7',
                    'packId': 'THE882.synthetic.fixture.20261015'}
    code, raceBefore = sk('/plugins/signalk-wakelogger/race-plan')
    assert code == 200 and (raceBefore.get('pack') or {}).get('available') is False, 'pack unexpectedly applied before receive'
    servedDirectory = tempfile.TemporaryDirectory(prefix='the882-provisional-')
    directory = Path(servedDirectory.name)
    for name in ['leg-eta.mjs', 'course-progress.mjs', 'instruments.mjs', 'wind-derivation.mjs']:
        with urllib.request.urlopen(bundle['signalk_url'] + '/signalk-wakelogger/' + name, timeout=20) as response:
            data = response.read()
        assert data == (ROOT / 'public' / name).read_bytes(), name
        (directory / name).write_bytes(data)
    lat, lon0 = -33.86, 151.211
    # Fresh native samples first: the isolated SK model prunes idle synthetic
    # values, so the vessel REST tree only resolves once samples are published.
    p = phase('psc', 0, 0, 4, lat, lon0)
    finish(p)
    time.sleep(1)
    course0, _ = readback()
    assert course0['legStart'], 'no leg marker baseline'
    R['baselineMarker'] = course0['legStart']
    enabled = mode('automatic')
    R['receive'] = {'enabledAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'watch': []}
    save()
    deadline = time.time() + 60
    race = None
    while time.time() < deadline:
        code, candidate = sk('/plugins/signalk-wakelogger/race-plan')
        assert code == 200
        pack = (candidate or {}).get('pack') or {}
        current = status()
        R['receive']['watch'].append({'elapsedSeconds': round(60 - (deadline - time.time()), 1),
                                      'packAvailable': pack.get('available'), 'revision': pack.get('revision'),
                                      'applicable': pack.get('applicable'),
                                      'acknowledgedSequence': current['queue']['acknowledgedSequence'],
                                      'remainingSamples': (current['historicalUpload'] or {}).get('remainingSamples')})
        save()
        if pack.get('available'):
            race = candidate
            break
        time.sleep(2)
    assert race, ('pack not received during bounded interval', R['receive']['watch'][-3:])
    pack = race['pack']
    assert pack['revision'] == expectedPack['revision'] and pack['sha256'] == expectedPack['sha256'], pack
    assert pack['packId'] == expectedPack['packId'] and pack['applicable'] is True, pack
    assert pack['courseDefinitionDigest'] == '2342f0a86d7362a72d32c5d90e6ba78a54c97a1607dd90f5b5fe6519477a59b0', pack
    R['packReceived'] = {k: pack[k] for k in ['available', 'packId', 'revision', 'sha256', 'ruleSetVersion', 'courseId',
                                               'racePlanId', 'courseDefinitionDigest', 'generatedAt', 'validFrom',
                                               'validUntil', 'appliedAt', 'applicable', 'currentAt']}
    save()
    time.sleep(8)
    drained = status()
    R['drainDuringReceive'] = {'queue': drained['queue'], 'historicalUpload': drained['historicalUpload'],
                               'disclosure': 'natural ACK/queue progression to the isolated receiver; never purged, rewound or reinserted'}
    save()
    # Fresh navigation inputs, then return to the persisted OFF state.
    p = phase('psc', 0, 0, 4, lat, lon0)
    finish(p)
    time.sleep(1)
    disabled = mode('local_only')
    R['receive']['disabledAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    time.sleep(4)
    afterOff = status()
    code, raceOff = sk('/plugins/signalk-wakelogger/race-plan')
    assert code == 200
    assert afterOff['uploadMode'] == 'local_only' and afterOff['persistedUploadMode'] == 'local_only' and not afterOff['liveTrackingEnabled']
    assert (raceOff.get('pack') or {}).get('available') is True, 'applied pack lost after OFF'
    assert afterOff['queue']['acknowledgedSequence'] >= before['queue']['acknowledgedSequence']
    assert afterOff['queue']['currentSequence'] >= before['queue']['currentSequence']
    R['off'] = {'uploadMode': afterOff['uploadMode'], 'trackingSessionId': afterOff['trackingSessionId'],
                'trackingState': afterOff['trackingState'], 'queue': afterOff['queue'],
                'historicalUpload': afterOff['historicalUpload'], 'packStillApplied': True}
    save()
    snap = raceOff.get('latestSnapshot')
    if not snap:
        code, calc = sk('/plugins/signalk-wakelogger/race-plan/recalculate', {})
        assert code == 200 and calc.get('calculated'), (code, calc)
        raceOff = sk('/plugins/signalk-wakelogger/race-plan')[1]
        snap = raceOff.get('latestSnapshot')
    assert snap and snap['packRevision'] == expectedPack['revision'], (snap or {}).get('packRevision')
    legs = ((snap.get('plan') or {}).get('legs') or [])
    assert legs, 'snapshot carries no plan legs'
    planSpeed = legs[0].get('estimatedSogKnots')
    assert isinstance(planSpeed, (int, float)) and 0.5 <= planSpeed <= 30, planSpeed
    courseD, _ = readback()
    desired = courseD['desired']
    assert raceOff['pack']['courseId'] == desired['courseId'], (raceOff['pack']['courseId'], desired['courseId'])
    assert snap['tracking']['courseId'] == desired['courseId']
    assert snap['tracking']['activeIndex'] == desired['activeWaypointIndex']
    assert snap['tracking']['reverse'] is False
    R['snapshot'] = {'id': snap.get('id'), 'generatedAt': snap['generatedAt'], 'source': snap.get('source'),
                     'packId': snap['packId'], 'packRevision': snap['packRevision'], 'packSha256': snap['packSha256'],
                     'tracking': snap['tracking'], 'estimatedSogKnotsFirstLeg': planSpeed, 'warning': snap.get('warning'),
                     'forecastCoverage': snap.get('forecastCoverage')}
    save()
    # Reset boundary: real course activation rebases the leg marker.
    code, activated = sk('/plugins/signalk-wakelogger/course/activate', {})
    assert code == 200, (code, activated)
    p = phase('psc', 0, 0, 4, lat, lon0)
    finish(p)
    time.sleep(1)
    courseA, _ = readback()
    assert courseA['legStart']['startedAt'] > course0['legStart']['startedAt'], 'activation did not reset the marker'
    R['reset'] = {'before': course0['legStart'], 'after': courseA['legStart'], 'activation': {'http': code, 'activation': activated.get('activation')}}
    save()
    provisional = observe(directory, 'provisional-plan-speed-value',
                          'numeric early-leg ETA from the received Race Plan leg plan speed')
    result = provisional['result']
    assert provisional['ageSeconds'] < 60, provisional['ageSeconds']
    assert result['etaProvisional'] is True and result['etaReason'] == 'Provisional · leg plan speed', result
    assert result['vmgKn'] == planSpeed, (result['vmgKn'], planSpeed)
    assert result['eta'] and abs(result['timeToGo'] - result['distanceNm'] / result['vmgKn'] * 3600) < 1e-6, result
    startedAt = courseA['legStart']['startedAt']
    # Transition/boundary: continuous eastbound leg progress across the 60 s window.
    p = phase('psc', 0, 130, 72, lat, lon0)
    beforeBoundary = None
    afterBoundary = None
    while time.time() * 1000 - startedAt < 66000:
        elapsed = time.time() * 1000 - startedAt
        if beforeBoundary is None and elapsed >= 53000 and elapsed < 59000:
            beforeBoundary = observe(directory, 'boundary-before-min-window')
            assert beforeBoundary['result']['etaProvisional'] is True and beforeBoundary['result']['etaReason'] == 'Provisional · leg plan speed', beforeBoundary['result']
        if afterBoundary is None and elapsed >= 63000:
            afterBoundary = observe(directory, 'boundary-after-min-window')
            assert afterBoundary['result']['etaProvisional'] is False and afterBoundary['result']['etaReason'] is None, afterBoundary['result']
            assert afterBoundary['result']['eta'] and afterBoundary['result']['vmgKn'] > 0
        time.sleep(2)
    finish(p, timeout=30)
    assert beforeBoundary and afterBoundary, (bool(beforeBoundary), bool(afterBoundary))
    courseB, _ = readback()
    assert courseB['legStart']['startedAt'] == startedAt, 'leg marker moved during transition'
    R['transition'] = {'before': beforeBoundary['ageSeconds'], 'after': afterBoundary['ageSeconds'],
                       'beforeProvisional': beforeBoundary['result']['etaProvisional'], 'afterProvisional': afterBoundary['result']['etaProvisional'],
                       'beforeVmgKn': beforeBoundary['result']['vmgKn'], 'afterVmgKn': afterBoundary['result']['vmgKn']}
    save()
    # Recovery: stale inputs, then recovered numeric leg-average without rebasing.
    time.sleep(33)
    stale = observe(directory, 'stale-after-provisional')
    assert stale['result']['eta'] is None and stale['result']['etaReason'] == 'Fresh navigation inputs unavailable', stale['result']
    p = phase('psc', 130, 160, 14, lat, lon0)
    time.sleep(9)
    recovered = observe(directory, 'recovery-after-stale-provisional')
    finish(p, timeout=30)
    assert recovered['result']['eta'] and recovered['result']['vmgKn'] > 0 and recovered['result']['etaProvisional'] is False and recovered['result']['etaReason'] is None, recovered['result']
    courseC, _ = readback()
    assert courseC['legStart']['startedAt'] == startedAt, 'recovery rebased the leg'
    save()
    after = status()
    assert after['uploadMode'] == 'local_only' and after['persistedUploadMode'] == 'local_only' and not after['liveTrackingEnabled']
    assert after['queue']['acknowledgedSequence'] >= before['queue']['acknowledgedSequence']
    assert after['queue']['droppedCount'] == 0
    R['trackingAfter'] = {k: after[k] for k in ['uploadMode', 'persistedUploadMode', 'liveTrackingEnabled', 'trackingSessionId', 'trackingState', 'queue', 'historicalUpload']}
    R['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    servedDirectory.cleanup()
    print('PASS numeric provisional plan-speed proof at pack revision3: receive, value', provisional['result']['vmgKn'],
          'kn plan label, boundary', beforeBoundary['ageSeconds'], '->', afterBoundary['ageSeconds'], 's, stale+recovery; final persisted OFF')

if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        if receiptPath.exists():
            attempt = receiptPath.with_name('dev-native-eta-provisional-attempt1.json')
            index = 2
            while attempt.exists():
                attempt = receiptPath.with_name(f'dev-native-eta-provisional-attempt{index}.json')
                index += 1
            receiptPath.rename(attempt)
        raise
