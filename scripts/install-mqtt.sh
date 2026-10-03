#!/usr/bin/env bash
# Install and configure a Mosquitto MQTT broker tuned for a Meshtastic mesh.
#
# Why run your own broker: the public broker (mqtt.meshtastic.org) rate-limits and strips a lot of
# detail (neighbor info, precise position), so tools like HopWatch and MeshView cannot show
# neighbors or a full live map from it. Your own broker receives everything your gateways uplink, so
# the live map, neighbor links, and coverage all work. This script sets one up in one shot.
#
# It is standalone: you do NOT need HopWatch installed to use it (run it on any Debian/Ubuntu host to
# get a broker for MeshView or your own tooling). It is idempotent: re-running updates the config and
# the user without clobbering anything else.
#
# Usage:
#   sudo bash scripts/install-mqtt.sh                      # auth on, user "meshtastic", random password
#   sudo bash scripts/install-mqtt.sh --user=NAME --password=SECRET
#   sudo bash scripts/install-mqtt.sh --anonymous         # no auth (LAN-only / testing; see warning)
#   sudo bash scripts/install-mqtt.sh --port=1883 --no-service
#   flags: --user=NAME --password=SECRET --anonymous --port=N --no-service
set -euo pipefail

MQ_USER="meshtastic"
MQ_PASS=""
ANON=0
PORT=1883
DO_SERVICE=1
for a in "$@"; do
  case "$a" in
    --user=*) MQ_USER="${a#*=}" ;;
    --password=*) MQ_PASS="${a#*=}" ;;
    --anonymous) ANON=1 ;;
    --port=*) PORT="${a#*=}" ;;
    --no-service) DO_SERVICE=0 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m>>> %s\033[0m\n' "$1"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
gen() { openssl rand -hex 12 2>/dev/null || head -c 9 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9'; }

CONF="/etc/mosquitto/conf.d/meshtastic.conf"
PWFILE="/etc/mosquitto/passwd"

step "Installing Mosquitto"
if ! command -v mosquitto >/dev/null 2>&1; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y mosquitto mosquitto-clients
else
  echo "mosquitto already installed: $(mosquitto -h 2>&1 | head -1)"
fi

step "Writing broker config ($CONF)"
# Mosquitto 2.x has no default network listener, so we must declare one. Binding on all interfaces
# lets your gateways (and HopWatch/MeshView) reach it; firewall the port if this host is public.
if [ "$ANON" -eq 1 ]; then
  AUTH_LINES="allow_anonymous true"
  echo "WARNING: anonymous access is ON. Only do this on a trusted LAN, never on a public IP."
else
  AUTH_LINES=$'allow_anonymous false\npassword_file '"$PWFILE"
  if [ -z "$MQ_PASS" ]; then MQ_PASS="$(gen)"; GEN_SHOWN=1; fi
fi

$SUDO tee "$CONF" >/dev/null <<EOF
# Mosquitto broker for a Meshtastic mesh (managed by HopWatch install-mqtt.sh).
listener $PORT
# Bind on all interfaces so gateways and HopWatch/MeshView can connect. If this host is reachable
# from the internet, restrict $PORT with a firewall to trusted sources, or add a TLS listener.
$AUTH_LINES
persistence true
persistence_location /var/lib/mosquitto/
# A busy mesh is chatty; keep queues and payloads sane.
max_queued_messages 20000
message_size_limit 100000
EOF

if [ "$ANON" -ne 1 ]; then
  step "Creating MQTT user '$MQ_USER'"
  if [ -f "$PWFILE" ]; then
    $SUDO mosquitto_passwd -b "$PWFILE" "$MQ_USER" "$MQ_PASS"
  else
    $SUDO mosquitto_passwd -c -b "$PWFILE" "$MQ_USER" "$MQ_PASS"
  fi
  $SUDO chown mosquitto:mosquitto "$PWFILE" 2>/dev/null || true
  $SUDO chmod 600 "$PWFILE" 2>/dev/null || true
fi

if [ "$DO_SERVICE" -eq 1 ]; then
  step "Enabling + restarting mosquitto"
  $SUDO systemctl enable mosquitto >/dev/null 2>&1 || true
  $SUDO systemctl restart mosquitto
  sleep 1
  $SUDO systemctl is-active mosquitto >/dev/null 2>&1 && echo "mosquitto is active" || { echo "mosquitto failed to start; check: journalctl -u mosquitto -n 50"; exit 1; }
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -z "$IP" ] && IP="<this-host-ip>"
cat <<EOF

==================== MQTT broker ready ====================
 Address (gateways / tools):  $IP   (or a DNS name you point at this host)
 Port:                        $PORT
EOF
if [ "$ANON" -eq 1 ]; then
  echo " Auth:                        anonymous (no username/password)"
else
  echo " Username:                    $MQ_USER"
  echo " Password:                    $MQ_PASS${GEN_SHOWN:+   <-- generated, save it now; not shown again}"
fi
cat <<EOF

 Point each Meshtastic gateway at it (Config > MQTT):
   - MQTT enabled: ON,  Address: $IP:$PORT $([ "$ANON" -eq 1 ] || echo ",  Username/Password as above")
   - Root topic: msh  (keep the default unless you have a reason)
   - Turn ON "Map reporting" and, on your channel, "Uplink enabled" (and "OK to MQTT")
     so neighbor info and position actually reach the broker -- that is what the public
     broker withholds and why a live map can show neighbors.

 Point HopWatch or MeshView at it:  host 127.0.0.1 (same box) or $IP, port $PORT,
   topic msh/#  (HopWatch: add it under /admin > Settings > MQTT brokers).

 Quick test (subscribe and watch traffic arrive):
   mosquitto_sub -h 127.0.0.1 -p $PORT $([ "$ANON" -eq 1 ] || echo "-u $MQ_USER -P '<password>'") -t 'msh/#' -v
===========================================================
EOF
