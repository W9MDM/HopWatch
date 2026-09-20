#!/usr/bin/env bash
# HopWatch auto-update check, run by hopwatch-update.timer (deploy/systemd/).
# Updates when the git remote has new commits, or when an admin pressed "Update now"
# in /admin (a service_control DB row written by the web UI; processes talk only
# through the database). The heavy lifting (pull, deps, migrate, build) is
# scripts/linux-update.sh; this script then restarts the systemd units itself.
#
# The unit runs this as root so it can restart services without sudo; every git/npm/
# node step drops to HOPWATCH_RUN_USER (runuser) so repo ownership and the app user's
# stored git credentials stay correct. Running it manually as the app user also works
# (restarts then fall back to linux-update.sh's own sudo path).
set -euo pipefail
cd "$(dirname "$0")/.."

# Single-flight: a build can easily outlast the timer interval.
exec 9>"/tmp/hopwatch-update.lock"
flock -n 9 || exit 0

RUN_USER="${HOPWATCH_RUN_USER:-}"
as_user() {
  if [ -n "$RUN_USER" ] && [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != "root" ]; then
    runuser -u "$RUN_USER" -- "$@"
  else
    "$@"
  fi
}

# 1) Admin "Update now" request? Claims (and clears) the DB row; env comes from the
#    unit's EnvironmentFile. A DB hiccup reads as "no request" and costs one tick.
requested=0
if out=$(as_user node scripts/update-request.ts claim 2>/dev/null); then
  [ "$out" = "1" ] && requested=1
fi

# 2) New commits on the tracked remote branch?
behind=0
if [ -d .git ]; then
  as_user git fetch --quiet || true
  local_rev=$(as_user git rev-parse HEAD)
  remote_rev=$(as_user git rev-parse '@{u}' 2>/dev/null || echo "$local_rev")
  [ "$local_rev" != "$remote_rev" ] && behind=1
fi

if [ "$requested" -eq 0 ] && [ "$behind" -eq 0 ]; then exit 0; fi

echo "hopwatch-update: updating (requested=${requested} new_commits=${behind})"
as_user bash scripts/linux-update.sh --no-restart

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
for svc in hopwatch-ingest hopwatch-worker hopwatch-web; do
  if [ -f "/etc/systemd/system/${svc}.service" ]; then
    $SUDO systemctl restart "$svc" && echo "  restarted $svc" || echo "  ! failed to restart $svc"
  fi
done
echo "hopwatch-update: done"
