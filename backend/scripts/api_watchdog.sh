#!/bin/sh
# Restarts auto-trader-demo when it stops answering. Restart=always only
# catches the process exiting; on 2026-10-20 it stayed alive but stopped
# accepting connections, and nothing restarted it.
#
# Deliberately slow to act: three consecutive misses (about three minutes at
# the timer's 1-minute cadence), each with a 10s budget. Under swap pressure
# the API is slow but alive, and an early restart there only makes every open
# chart reload from scratch; the first version (two misses, 5s) restarted the
# API five times during one memory crunch.
#
# Installed by scripts/deploy-demo.sh, run by auto-trader-watchdog.timer.

URL="http://127.0.0.1:8010/api/brokers"
COUNT_FILE=/tmp/auto-trader-watchdog.misses
MAX_MISSES=3

if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then
  rm -f "$COUNT_FILE"
  exit 0
fi

misses=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
if [ "$misses" -ge "$MAX_MISSES" ]; then
  rm -f "$COUNT_FILE"
  logger -t auto-trader-watchdog "API unresponsive $misses checks in a row, restarting"
  systemctl restart auto-trader-demo.service
else
  echo "$misses" > "$COUNT_FILE"
fi
