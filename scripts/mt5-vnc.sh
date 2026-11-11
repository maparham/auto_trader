#!/usr/bin/env bash
# Open the self-hosted MT5 terminal's screen (Wine under Xvnc on the prod box).
# Xvnc listens on the host's 127.0.0.1:5901 only, so this tunnels it over SSH
# and opens macOS Screen Sharing on the local end. The VNC password is the one
# in the host's ~/.vnc/passwd.
#
#   scripts/mt5-vnc.sh          open the tunnel (if needed) and Screen Sharing
#   scripts/mt5-vnc.sh close    close the tunnel
#   scripts/mt5-vnc.sh status   say whether the tunnel is up
#
# MT5_VNC_HOST and MT5_VNC_PORT override the host and the local port.
set -euo pipefail
HOST=${MT5_VNC_HOST:-ec2-user@3.139.146.5}
PORT=${MT5_VNC_PORT:-5901}
FWD="$PORT:localhost:5901"

tunnel_up() { pgrep -f -- "-L $FWD" >/dev/null; }

case "${1:-open}" in
  open)
    if tunnel_up; then
      echo "tunnel already up on localhost:$PORT"
    else
      ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L "$FWD" "$HOST"
      echo "tunnel up: localhost:$PORT -> $HOST:5901"
    fi
    open "vnc://localhost:$PORT"
    ;;
  close)
    if tunnel_up; then
      pkill -f -- "-L $FWD"
      echo "tunnel closed"
    else
      echo "no tunnel open"
    fi
    ;;
  status)
    if tunnel_up; then echo "tunnel up on localhost:$PORT"; else echo "no tunnel open"; fi
    ;;
  *)
    echo "usage: $0 [open|close|status]" >&2
    exit 2
    ;;
esac
