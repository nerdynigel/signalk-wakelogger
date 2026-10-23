#!/bin/sh
set -eu
data_dir="${1:?Usage: prepare.sh DATA_DIRECTORY WAKELOGGER_REPOSITORY}"
web_repo="${2:?Specify the Wake Logger repository for its tested DAT framing definitions}"
tool_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
docker run --rm --user "$(id -u):$(id -g)" --entrypoint python \
  -v "$web_repo/api/app/services/ydvr_decoder.py:/decoder.py:ro" \
  -v "$tool_dir:/tool:ro" -v "$data_dir:/data" wakelogger-api:latest \
  /tool/prepare_frames.py /data/source.zip /data/frames.ndjson /decoder.py \
  2026-06-28T03:06:00Z 2026-06-28T03:26:00Z
docker run --rm --user "$(id -u):$(id -g)" --entrypoint node \
  -v "$tool_dir:/tool:ro" -v "$data_dir:/data" signalk-signalk \
  /tool/convert.cjs /data/frames.ndjson /data/clip.ndjson
