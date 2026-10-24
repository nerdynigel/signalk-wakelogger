#!/bin/sh
# Read-only production export. No credentials, database dumps or writes.
set -eu
data_dir="${1:?Usage: fetch-source.sh PRIVATE_DATA_DIRECTORY}"
mkdir -p "$data_dir"
chmod 700 "$data_dir"
ssh -o BatchMode=yes -o ConnectTimeout=10 wakelogger-prod \
  'cd /root/wakelogger && docker compose exec -T api python -' > "$data_dir/source.zip.part" <<'PY'
import sys
from sqlalchemy import text
from app.core.database import engine
from app.core.storage import get_s3_client
from app.core.config import settings
with engine.connect() as c:
    c.execute(text('SET TRANSACTION READ ONLY'))
    row=c.execute(text('SELECT u.object_key,u.original_filename FROM voyage_uploads u JOIN voyages v ON v.track_source_upload_id=u.id WHERE v.id=48')).mappings().one()
    assert row['original_filename']=='20260628-SAGS.zip', 'Trip source changed; review before exporting'
    body=get_s3_client().get_object(Bucket=settings.s3_bucket_uploads,Key=row['object_key'])['Body']
    while chunk:=body.read(1024*1024):sys.stdout.buffer.write(chunk)
    c.rollback()
PY
mv "$data_dir/source.zip.part" "$data_dir/source.zip"
ssh -o BatchMode=yes -o ConnectTimeout=10 wakelogger-prod \
  'cd /root/wakelogger && docker compose exec -T api python -' > "$data_dir/source-course.json.part" <<'PY'
import json
from sqlalchemy import text
from app.core.database import engine
with engine.connect() as c:
    c.execute(text('SET TRANSACTION READ ONLY'))
    print(json.dumps(c.execute(text('SELECT race_route_snapshot_json FROM voyages WHERE id=48')).scalar_one()))
    c.rollback()
PY
mv "$data_dir/source-course.json.part" "$data_dir/source-course.json"
chmod 600 "$data_dir/source.zip" "$data_dir/source-course.json"
