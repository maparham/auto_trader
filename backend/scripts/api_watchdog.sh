#!/bin/sh
# Hits the main API's lightest endpoint with a short timeout; restarts the
# service if it doesn't answer twice in a row. Restart=always on
# auto-trader-demo.service only catches the process EXITING — it did not
# fire during the 2026-10-20 incident because the process stayed alive but
# wedged (its event loop stopped accepting connections). This catches that.
#
# Two consecutive failures, not one, before acting: a single slow candle
# fetch (cold capital-live fetches routinely take close to the 5s budget
# below) should not trigger a restart. At the 1-minute timer cadence this
# unit runs on, two failures means ~confirmed-down for about a minute.
#
# Installed by scripts/deploy-demo.sh, run by auto-trader-watchdog.timer.

URL="http://127.0.0.1:8010/api/brokers"
LOCK=/tmp/auto-trader-watchdog.lock

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  rm -f "$LOCK"
else
  if [ -f "$LOCK" ]; then
    rm -f "$LOCK"
    logger -t auto-trader-watchdog "API unresponsive twice in a row, restarting"
    systemctl restart auto-trader-demo.service
  else
    touch "$LOCK"
  fi
fi
