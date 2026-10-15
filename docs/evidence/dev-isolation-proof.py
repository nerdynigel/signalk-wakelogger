"""THE-882 fresh isolation/synthetic precondition proof for the authorized
bounded automatic-mode Race Pack receive interval (Chief comment 77fa4eeb).
Read-only: container networks/ports, plugin destinations, synthetic dataset.
Never persists credentials, secrets or private host addresses.
"""
import datetime
import json
import re
import subprocess
from pathlib import Path
import runpy

C = runpy.run_path(str(Path(__file__).with_name('dev-feature-client.py')))
api, status = C['api'], C['status']
ROOT = C['ROOT']
HOST = 'nigel@' + C['bundle']['signalk_url'].split('//', 1)[-1].split(':', 1)[0].rstrip('/')
SCOPE = 'wakelogger-scope-a-'
receiptPath = ROOT / 'docs/evidence/dev-isolation-proof.json'
assert not receiptPath.exists(), 'single-use driver: isolation receipt already exists'

def ssh(script):
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, script],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, (script, result.stderr[:300])
    return result.stdout

def main():
    R = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'synthetic': True,
         'purpose': 'fresh precondition proof before the bounded automatic-mode receive interval'}
    listing = ssh("docker ps --format '{{.Names}}|{{.Networks}}|{{.Ports}}'")
    containers = {}
    for line in listing.splitlines():
        name, networks, ports = line.split('|')
        if name.startswith(SCOPE):
            containers[name] = {'networks': sorted(networks.split(',')), 'ports': ports.strip()}
    expected = {
        SCOPE + 'api-1': ('isolated-only', set()),
        SCOPE + 'signalk-1': ('isolated-only', set()),
        SCOPE + 'broker-1': ('isolated-only', set()),
        SCOPE + 'db-1': ('isolated-only', set()),
        SCOPE + 'minio-1': ('isolated-only', set()),
        SCOPE + 'gateway-1': ('entry+isolated', {'3002', '8020'}),
        SCOPE + 'frontend-1': ('entry+isolated', {'3010'}),
    }
    assert set(containers) == set(expected), sorted(containers)
    published = set()
    for name, (kind, hosted) in expected.items():
        entry = containers[name]
        isolated = name.endswith(('api-1', 'signalk-1', 'broker-1', 'db-1', 'minio-1'))
        mappings = [part.strip() for part in entry['ports'].split(',') if '->' in part]
        exposed = sorted(part.strip() for part in entry['ports'].split(',') if part.strip() and '->' not in part)
        if isolated:
            assert entry['networks'] == ['wakelogger-scope-a_isolated'], (name, entry['networks'])
            assert not mappings, (name, entry['ports'])
        else:
            assert entry['networks'] == ['wakelogger-scope-a_entry', 'wakelogger-scope-a_isolated'], (name, entry['networks'])
        for mapping in mappings:
            host = mapping.split('->')[0].split(':')[-1]
            published.add(host)
            assert host in hosted, (name, mapping)
        entry['exposedOnly'] = exposed
        entry['publishedHostPorts'] = sorted(mapping.split('->')[0].split(':')[-1] for mapping in mappings)
    R['containers'] = {name: containers[name] for name in sorted(containers)}
    R['publishedHostPorts'] = sorted(published)
    # Loopback-only or absent published ports on the isolated services; the
    # broker/DB/minio/api/signalk are reachable only on the isolated network.
    config = json.loads(ssh("docker exec " + SCOPE + "signalk-1 cat /home/node/.signalk/plugin-config-data/signalk-wakelogger.json"))
    assert config['configuration']['uploadMode'] == 'local_only'
    pairing = config['configuration']['pairingApiUrl']
    assert re.fullmatch(r'https://gateway:8443/backend/v1/signalk/pair', pairing), pairing
    R['plugin'] = {'enabled': config['enabled'], 'uploadMode': config['configuration']['uploadMode'],
                   'pairingDestination': 'gateway:8443 (internal compose service)'}
    credentials = json.loads(ssh("docker exec " + SCOPE + "signalk-1 cat /home/node/.signalk/plugin-config-data/signalk-wakelogger/identity/credentials.json"))
    R['device'] = {'deviceId': credentials['deviceId'], 'mqttHost': credentials['mqttHost'],
                   'mqttPort': credentials['mqttPort'], 'tls': credentials['tls'],
                   'associationStatusTemplate': 'gateway:8443 (internal compose service)'}
    assert credentials['mqttHost'] == 'broker' and credentials['mqttPort'] == 1883 and credentials['tls'] is False
    assert re.fullmatch(r'https://gateway:8443/backend/v1/signalk/devices/[0-9a-f-]+/association', credentials['associationStatusUrl'])
    raw = json.dumps(R)
    assert 'password' not in raw.lower() and 'token' not in raw.lower() and '10.0.0.' not in raw
    archiveListing = ssh("docker exec " + SCOPE + "signalk-1 sh -lc 'ls /home/node/.signalk/plugin-config-data/signalk-wakelogger/track-archive/7b0fddba-*/*.wlt'")
    outboxListing = ssh("docker exec " + SCOPE + "signalk-1 sh -lc 'ls /home/node/.signalk/plugin-config-data/signalk-wakelogger/outbox/7b0fddba-*/'")
    overview = api('/v1/vessels/4/telemetry/overview')
    cloudRecordings = sorted(record['id'] for record in overview['recordings'])
    assert len(cloudRecordings) == 5, cloudRecordings
    missing = [recordingId for recordingId in cloudRecordings if recordingId not in archiveListing]
    assert not missing, (missing, archiveListing)
    assert 'segment-' in outboxListing, outboxListing
    R['recordings'] = {'cloudIds': cloudRecordings, 'allArchivedOnDevice': True,
                       'outboxSegmentsPresent': True,
                       'syntheticDisclosure': 'all five recordings are this DEV tranche\u2019s synthetic fixtures'}
    tracking = status()
    assert tracking['uploadMode'] == 'local_only' and not tracking['liveTrackingEnabled']
    assert tracking['trackingSessionId'] == '5f835fd9-cd30-45ab-bd08-454c2416e1ec'
    assert tracking['queue']['acknowledgedSequence'] == 647 and tracking['queue']['currentSequence'] == 1439
    assert tracking['queue']['droppedCount'] == 0
    R['tracking'] = {'uploadMode': tracking['uploadMode'], 'trackingSessionId': tracking['trackingSessionId'],
                     'trackingState': tracking['trackingState'], 'queue': tracking['queue'],
                     'historicalUpload': tracking['historicalUpload'],
                     'syntheticDisclosure': 'every sequence in the queue belongs to this DEV tranche\u2019s synthetic fixtures; no real vessel data exists in this instance'}
    R['conclusion'] = {
        'instance': 'this exact scope-a compose project on the isolated internal network',
        'broker': 'internal compose service broker:1883; no published port',
        'ingestion': 'cloud API/worker on the isolated network; gateway:8443 internal',
        'uploadDestinations': 'device credentials bind pairing/association to gateway:8443 only; no external destination configured',
        'queuedData': 'synthetic tranche fixtures only (recordings listed above)',
        'ok': True,
    }
    receiptPath.write_text(json.dumps(R, indent=2) + '\n')
    print('PASS isolation proof: 7 scope-a containers isolated, broker/gateway internal, OFF, queue synthetic', tracking['queue']['messageCount'])

if __name__ == '__main__':
    main()
