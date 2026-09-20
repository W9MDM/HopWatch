#!/usr/bin/env bash
# HopWatch one-shot production install for Linux + MariaDB.
#
# By default this does EVERYTHING:
#   - installs npm dependencies
#   - creates config/hopwatch.yaml and .env from the examples
#   - generates the DB password, admin password, and session secret
#   - creates the MariaDB database + user via socket login (sudo mariadb, no root password)
#   - points the app at the MariaDB unix socket
#   - runs migrations and builds the web app
#   - installs and enables systemd services (ingest, worker, web)
#
# Usage:
#   sudo bash scripts/linux-install.sh                 # full setup
#   bash scripts/linux-install.sh --no-systemd         # skip services
#   bash scripts/linux-install.sh --no-db              # skip DB provisioning
#   bash scripts/linux-install.sh --user=hopwatch      # run services as this user
#   flags: --no-db --no-systemd --no-build --user=NAME
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

DO_DB=1; DO_SYSTEMD=1; BUILD=1
SVC_USER="${SUDO_USER:-$(id -un)}"
for a in "$@"; do
  case "$a" in
    --no-db) DO_DB=0 ;;
    --no-systemd) DO_SYSTEMD=0 ;;
    --no-build) BUILD=0 ;;
    --user=*) SVC_USER="${a#*=}" ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m>>> %s\033[0m\n' "$1"; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

gen() { openssl rand -hex "${1:-24}" 2>/dev/null || node -e "process.stdout.write(require('crypto').randomBytes(${1:-24}).toString('hex'))"; }

set_env() { # set_env KEY VALUE  (replace or append in .env)
  local key="$1" val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

get_env() { grep "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# --- prerequisites ---
command -v node >/dev/null 2>&1 || { echo "Node.js 22.6+ is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".").map(Number)[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  echo "Node.js 22.6+ is required (found $(node -v))." >&2; exit 1
fi
NODE_BIN="$(dirname "$(command -v node)")"

# --- dependencies ---
step "Installing dependencies"
if [ -f package-lock.json ]; then npm ci --no-fund --no-audit; else npm install --no-fund --no-audit; fi

# --- config + env + secrets ---
step "Bootstrapping config and secrets"
[ -f config/hopwatch.yaml ] || cp config/hopwatch.example.yaml config/hopwatch.yaml
[ -f .env ] || cp .env.example .env
mkdir -p data/spool data/terrain

# Session secret (always ensure a strong one).
CUR_SECRET="$(get_env HOPWATCH_SESSION_SECRET)"
if [ -z "$CUR_SECRET" ] || [ "$CUR_SECRET" = "change-me-to-a-long-random-string" ]; then
  set_env HOPWATCH_SESSION_SECRET "$(gen 32)"; echo "  generated HOPWATCH_SESSION_SECRET"
fi
# Master key for encrypting UI-entered secrets at rest.
CUR_MASTER="$(get_env HOPWATCH_MASTER_KEY)"
if [ -z "$CUR_MASTER" ] || [ "$CUR_MASTER" = "change-me-to-a-different-long-random-string" ]; then
  set_env HOPWATCH_MASTER_KEY "$(gen 32)"; echo "  generated HOPWATCH_MASTER_KEY"
fi
# Admin password (generate + show once if still default/empty).
CUR_ADMIN="$(get_env HOPWATCH_ADMIN_PASSWORD)"
ADMIN_SHOWN=""
if [ -z "$CUR_ADMIN" ] || [ "$CUR_ADMIN" = "changeme" ]; then
  ADMIN_SHOWN="$(gen 12)"; set_env HOPWATCH_ADMIN_PASSWORD "$ADMIN_SHOWN"
fi

# --- database (MariaDB socket login) ---
if [ "$DO_DB" -eq 1 ]; then
  step "Provisioning MariaDB (socket login)"
  MARIADB="$(command -v mariadb || command -v mysql || true)"
  if [ -z "$MARIADB" ]; then
    echo "  ! mariadb/mysql client not found. Install the MariaDB client/server, then re-run." >&2
    echo "    Debian/Ubuntu: sudo apt install mariadb-server" >&2
    exit 1
  fi

  # A root admin shell over the socket. Prime sudo first so the SQL heredoc is never
  # mistaken for a sudo password prompt.
  if [ -n "$SUDO" ]; then
    $SUDO -v || { echo "  ! sudo is required to log into MariaDB as root over the socket." >&2; exit 1; }
  fi
  admin() { $SUDO "$MARIADB" "$@"; }

  # Confirm we can actually reach the server as root before doing anything.
  if ! echo 'SELECT 1;' | admin >/dev/null 2>db_err.log; then
    echo "  ! Could not connect to MariaDB as root via socket. Details:" >&2
    sed 's/^/      /' db_err.log >&2 || true
    echo "    Is the server running?  sudo systemctl status mariadb" >&2
    rm -f db_err.log
    exit 1
  fi
  rm -f db_err.log

  DB_NAME="$(node -e "const y=require('yaml').parse(require('fs').readFileSync('config/hopwatch.yaml','utf8'));process.stdout.write(String((y.database&&y.database.mysql&&y.database.mysql.database)||'hopwatch'))")"
  DB_USER="$(node -e "const y=require('yaml').parse(require('fs').readFileSync('config/hopwatch.yaml','utf8'));process.stdout.write(String((y.database&&y.database.mysql&&y.database.mysql.user)||'hopwatch'))")"
  DB_PASS="$(get_env HOPWATCH_DB_PASSWORD)"
  if [ -z "$DB_PASS" ] || [ "$DB_PASS" = "hopwatch" ]; then DB_PASS="$(gen 24)"; set_env HOPWATCH_DB_PASSWORD "$DB_PASS"; fi

  SOCKET="$(printf 'SELECT @@socket;' | admin -N -B 2>/dev/null || true)"
  [ -z "$SOCKET" ] && SOCKET="/run/mysqld/mysqld.sock"

  echo "  creating database '${DB_NAME}' and user '${DB_USER}'@'localhost'"
  if ! admin <<SQL 2>db_err.log
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
  then
    echo "  ! provisioning SQL failed:" >&2
    sed 's/^/      /' db_err.log >&2 || true
    rm -f db_err.log
    exit 1
  fi
  rm -f db_err.log

  # Verify the user and database actually exist now, and print the result.
  USER_OK="$(printf "SELECT COUNT(*) FROM mysql.user WHERE User='%s' AND Host='localhost';" "$DB_USER" | admin -N -B 2>/dev/null || echo 0)"
  DB_OK="$(printf "SHOW DATABASES LIKE '%s';" "$DB_NAME" | admin -N -B 2>/dev/null || true)"
  if [ "$USER_OK" = "1" ] && [ -n "$DB_OK" ]; then
    echo "  verified: database '${DB_NAME}' and user '${DB_USER}'@'localhost' exist (socket ${SOCKET})"
  else
    echo "  ! verification failed (user_rows=${USER_OK}, db='${DB_OK}'). Check MariaDB manually." >&2
    exit 1
  fi

  # Point the app at the socket (localhost password auth over the unix socket).
  if ! grep -q '^[[:space:]]*socket_path:' config/hopwatch.yaml; then
    sed -i "/^    host: /a\\    socket_path: ${SOCKET}" config/hopwatch.yaml
    echo "  set database.mysql.socket_path=${SOCKET} in config/hopwatch.yaml"
  fi
fi

# --- migrate ---
step "Running migrations"
if ! npm run migrate; then
  echo "  ! migrations failed: the app could not reach MariaDB with the configured settings." >&2
  echo "    Check config/hopwatch.yaml (socket_path, user) and .env (HOPWATCH_DB_PASSWORD)." >&2
  exit 1
fi

# --- build ---
if [ "$BUILD" -eq 1 ]; then
  step "Building web app"
  npm run build
fi

# --- systemd ---
if [ "$DO_SYSTEMD" -eq 1 ]; then
  step "Installing systemd services (user=${SVC_USER})"
  $SUDO chown -R "$SVC_USER" "$ROOT"
  for svc in ingest worker web; do
    src="deploy/systemd/hopwatch-${svc}.service"
    dst="/etc/systemd/system/hopwatch-${svc}.service"
    sed -e "s|__WORKDIR__|${ROOT}|g" -e "s|__USER__|${SVC_USER}|g" -e "s|__NODEBIN__|${NODE_BIN}|g" "$src" | $SUDO tee "$dst" >/dev/null
    echo "  installed $dst"
  done
  # Auto-update: a 1-minute timer runs scripts/linux-autoupdate.sh, which pulls,
  # rebuilds, and restarts when the git remote has new commits or an admin pressed
  # "Update now" in /admin. Disable with: systemctl disable --now hopwatch-update.timer
  for unit in hopwatch-update.service hopwatch-update.timer; do
    sed -e "s|__WORKDIR__|${ROOT}|g" -e "s|__USER__|${SVC_USER}|g" -e "s|__NODEBIN__|${NODE_BIN}|g" "deploy/systemd/${unit}" | $SUDO tee "/etc/systemd/system/${unit}" >/dev/null
    echo "  installed /etc/systemd/system/${unit}"
  done
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now hopwatch-ingest hopwatch-worker hopwatch-web
  $SUDO systemctl enable --now hopwatch-update.timer
  echo "  services enabled and started (auto-update timer on)"
fi

# --- done ---
step "Setup complete"
if [ "$DO_SYSTEMD" -eq 1 ]; then
  echo "Services: systemctl status hopwatch-web ; journalctl -u hopwatch-ingest -f"
else
  echo "Start manually: npm run ingest ; npm run worker ; npm run start"
fi
echo "Web UI: http://localhost:3000   Admin: /admin/login (user 'admin')"
[ -n "$ADMIN_SHOWN" ] && printf '\033[1mGenerated admin password: %s\033[0m  (also in .env)\n' "$ADMIN_SHOWN"
echo "Remember to edit config/hopwatch.yaml with your broker(s) and channel keys, then restart."
