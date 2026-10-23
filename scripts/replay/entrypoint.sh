#!/bin/sh
set -eu
npm install --prefix /home/node/.signalk --omit=dev --ignore-scripts --force /opt/signalk-wakelogger.tgz /replay-provider
exec /home/node/signalk/node_modules/.bin/signalk-server
