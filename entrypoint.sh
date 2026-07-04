#!/bin/sh
set -e
# Start cron daemon in background (-l 8 = log level: only log errors)
crond -l 8
# Start the web GUI server in the foreground (becomes PID 1)
exec node server.js
