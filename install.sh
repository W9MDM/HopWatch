#!/usr/bin/env bash
# HopWatch installer (Linux/macOS/Git-Bash). Delegates to the cross-platform Node script.
# Usage: ./install.sh [--create-db] [--skip-install] [--skip-migrate]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.6+ is required and was not found on PATH." >&2
  exit 1
fi

exec node scripts/setup.mjs "$@"
