#!/bin/sh
cd /app
# A feed run can exceed one minute when several articles require AI analysis.
# Skip overlapping cron invocations; the next run will pick up unseen entries.
flock -n /tmp/news-alert.lock node index.js || echo "[RUN] skipped overlapping invocation"
