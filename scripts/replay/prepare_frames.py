"""Extract original, timestamped CAN frames; never use the decoder's wall clock."""
import base64
import bisect
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import sys
import zipfile


def frames(data, decoder, diagnostics=None):
    offset, wraps, previous = 0, 0, None
    while offset < len(data):
        if offset + 6 > len(data):
            if diagnostics is not None:
                diagnostics.append({'offset': offset, 'timer': previous + wraps if previous is not None else None})
                return
            raise ValueError(f'Truncated record header at {offset}')
        timer, identifier = struct.unpack_from('<HI', data, offset)
        offset += 6
        if previous is not None and timer < previous:
            wraps += 60000
        previous = timer
        if identifier == 0xffffffff:
            length, meta = 8, None
        else:
            meta = decoder._parse_can_id(identifier)
            length = 3 if meta['pgn'] == 59904 else 8
            if meta['pgn'] in decoder.SEQUENCE_PGNS:
                if offset + 2 > len(data):
                    raise ValueError('Truncated coalesced record header')
                length = data[offset + 1]
                offset += 2
        if offset + length > len(data):
            if diagnostics is not None:
                diagnostics.append({'offset': offset, 'timer': timer + wraps})
                return
            raise ValueError(f'Truncated body at {offset}')
        body = data[offset:offset + length]
        offset += length
        if meta is not None:
            yield timer + wraps, meta, body


def prepare(archive, output, decoder_path, start, end, warmup=30):
    spec = importlib.util.spec_from_file_location('ydvr', decoder_path)
    decoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(decoder)
    start_ms = datetime.fromisoformat(start.replace('Z', '+00:00')).timestamp() * 1000
    end_ms = datetime.fromisoformat(end.replace('Z', '+00:00')).timestamp() * 1000
    selected, reports = [], []
    with zipfile.ZipFile(archive) as z:
        names = sorted((n for n in z.namelist() if n.lower().endswith('.dat')),
                       key=lambda n: [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', n.lower())])
        for name in names:
            data = z.read(name)
            anchors = []
            count = 0
            truncated = []
            for timer, meta, body in frames(data, decoder, truncated):
                count += 1
                if meta['pgn'] in (126992, 129029, 129033):
                    message = decoder.PGN_DECODERS[meta['pgn']](memoryview(body), meta=meta, rel_ms=timer)
                    at = message.get('absolute_time') if message else None
                    if at:
                        anchors.append((timer, at.timestamp() * 1000))
            if not anchors:
                raise ValueError(f'{name}: no recorded UTC clock anchors')
            timers = [a[0] for a in anchors]
            for tail in truncated:
                if tail['timer'] is None:
                    raise ValueError(f'{name}: untimed truncated tail')
                anchor_timer, anchor_utc = min(anchors, key=lambda a: abs(a[0]-tail['timer']))
                tail['sourceTimeMs'] = anchor_utc + tail['timer'] - anchor_timer
                if start_ms-warmup*1000 <= tail['sourceTimeMs'] < end_ms:
                    raise ValueError(f'{name}: truncated message inside selected replay interval')
            included = 0
            for timer, meta, body in frames(data, decoder, []):
                i = bisect.bisect_left(timers, timer)
                choices = anchors[max(0, i-1):min(len(anchors), i+1)]
                anchor_timer, anchor_utc = min(choices, key=lambda a: abs(a[0]-timer))
                at = anchor_utc + timer - anchor_timer
                if start_ms - warmup * 1000 <= at < end_ms:
                    if abs(anchor_timer-timer) > 30000:
                        raise ValueError(f'{name}: no UTC anchor within 30 seconds')
                    selected.append({'sourceTimeMs': round(at, 3), 'file': name, **meta,
                                     'data': base64.b64encode(body).decode()})
                    included += 1
            reports.append({'file': name, 'frames': count, 'anchors': len(anchors), 'selected': included, 'truncatedOutsideClip': truncated})
    selected.sort(key=lambda m: m['sourceTimeMs'])
    if not selected:
        raise ValueError('No frames in selected interval')
    Path(output).write_text(''.join(json.dumps(m, separators=(',', ':'))+'\n' for m in selected))
    report = {'sourceSha256': hashlib.sha256(Path(archive).read_bytes()).hexdigest(),
              'sourceStart': start, 'sourceEnd': end, 'warmupSeconds': warmup,
              'sourceVoyageId': 48, 'frames': len(selected), 'files': reports}
    Path(str(output)+'.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))


if __name__ == '__main__':
    prepare(*sys.argv[1:6])
