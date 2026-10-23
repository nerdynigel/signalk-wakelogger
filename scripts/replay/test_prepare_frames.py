import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone

from prepare_frames import prepare, frames


class RecordedFramesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.decoder_path = os.environ.get('YDVR_DECODER', '/decoder.py')
        spec = importlib.util.spec_from_file_location('decoder', cls.decoder_path)
        cls.decoder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.decoder)

    def record(self, timer, pgn, body):
        identifier = (2 << 26) | (pgn << 8) | 17
        extra = bytes([0, len(body)]) if pgn in self.decoder.SEQUENCE_PGNS else b''
        return struct.pack('<HI', timer, identifier) + extra + body

    def fixture(self, tail=b''):
        at = datetime(2026, 6, 28, 3, 6, tzinfo=timezone.utc)
        days = (at.date() - datetime(1970, 1, 1).date()).days
        clock = struct.pack('<BBHI', 0, 0, days, (3*3600+6*60)*10000)
        return (self.record(100, 126992, clock)
                + self.record(1100, 129025, bytes(range(8))) + tail)

    def run_prepare(self, directory, data):
        archive = Path(directory)/'source.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('00000001.DAT', data)
        output = Path(directory)/'frames.ndjson'
        prepare(archive, output, self.decoder_path, '2026-06-28T03:06:00Z', '2026-06-28T03:06:03Z', warmup=0)
        return output

    def test_original_clock_anchor_and_body_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.run_prepare(directory, self.fixture())
            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual(records[1]['sourceTimeMs'], datetime(2026, 6, 28, 3, 6, 1, tzinfo=timezone.utc).timestamp()*1000)
            self.assertEqual(records[1]['data'], 'AAECAwQFBgc=')
            self.assertEqual(records[1]['src'], 17)

    def test_truncation_in_selected_interval_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = self.record(2100, 129025, b'abc')
            with self.assertRaisesRegex(ValueError, 'inside selected'):
                self.run_prepare(directory, self.fixture(bad))

    def test_truncated_tail_outside_clip_is_disclosed(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.run_prepare(directory, self.fixture(self.record(5100, 129025, b'abc')))
            report = json.loads(Path(str(output)+'.json').read_text())
            self.assertEqual(len(report['files'][0]['truncatedOutsideClip']), 1)
            self.assertEqual(len(output.read_text().splitlines()), 2)

    def test_missing_utc_anchor_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'no recorded UTC'):
                self.run_prepare(directory, self.record(100, 129025, bytes(8)))

    def test_timer_wrap_and_coalesced_records(self):
        body = self.record(59000, 129025, bytes(8)) + self.record(10, 127489, bytes(26))
        parsed = list(frames(body, self.decoder))
        self.assertEqual([r[0] for r in parsed], [59000, 60010])
        self.assertEqual(len(parsed[1][2]), 26)


if __name__ == '__main__':
    unittest.main()
