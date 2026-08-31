#!/bin/sh
set -eu

config_root=/home/node/.signalk
archive=/opt/signalk-wakelogger.tgz
marker="$config_root/.signalk-wakelogger-test-package"
config_dir="$config_root/plugin-config-data"
config_file="$config_dir/signalk-wakelogger.json"
archive_digest=$(sha256sum "$archive" | cut -d ' ' -f 1)

mkdir -p "$config_dir"
if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$archive_digest" ]; then
  npm install --prefix "$config_root" --omit=dev --ignore-scripts --force "$archive"
  printf '%s\n' "$archive_digest" > "$marker"
fi

if [ ! -f "$config_file" ]; then
  umask 077
  cat > "$config_file" <<'JSON'
{
  "enabled": true,
  "configuration": {
    "pairingCode": "docker-e2e-pairing-code",
    "pairingApiUrl": "https://test-cloud:8443/pair",
    "samplePeriodMs": 1000,
    "maxOutboxMb": 10,
    "maxOutboxDays": 1,
    "debugTelemetry": false
  }
}
JSON
fi

exec /home/node/signalk/node_modules/.bin/signalk-server "$@"
