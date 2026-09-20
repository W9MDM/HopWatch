#!/usr/bin/env bash
# HopWatch in-place update for Linux.
#   - pulls latest (if a git checkout), reinstalls deps, migrates, rebuilds
#   - restarts the systemd services if they are installed
#
# Usage:
#   bash scripts/linux-update.sh [--no-build] [--no-restart] [--no-pull]
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD=1; RESTART=1; PULL=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-restart) RESTART=0 ;;
    --no-pull) PULL=0 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m>>> %s\033[0m\n' "$1"; }

if [ "$PULL" -eq 1 ] && [ -d .git ]; then
  step "Pulling latest"
  git pull --ff-only || echo "  ! git pull skipped (not fast-forward or no remote)"
fi

step "Installing dependencies"
if [ -f package-lock.json ]; then npm ci --no-fund --no-audit; else npm install --no-fund --no-audit; fi

step "Running migrations"
npm run migrate

if [ "$BUILD" -eq 1 ]; then
  step "Rebuilding web app"
  npm run build
fi

if [ "$RESTART" -eq 1 ]; then
  step "Restarting services"
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  restarted=0
  # Check each unit file on disk (avoids a pipefail/SIGPIPE false-negative from
  # `systemctl list-unit-files | grep -q`) and restart each present unit on its own,
  # so a missing or failing ingest/worker never blocks the web restart.
  for svc in hopwatch-ingest hopwatch-worker hopwatch-web; do
    if [ -f "/etc/systemd/system/${svc}.service" ]; then
      if $SUDO systemctl restart "$svc"; then
        echo "  restarted $svc"
      else
        echo "  ! failed to restart $svc (see: journalctl -u $svc -n 50)"
      fi
      restarted=1
    fi
  done
  if [ "$restarted" -eq 0 ]; then
    echo "  ! hopwatch systemd services not found; restart your processes manually"
  fi
fi

step "Update complete"
