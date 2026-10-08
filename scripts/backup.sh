#!/bin/sh
# Back up the Cadence database (Linux / Raspberry Pi). Suitable for cron.
# Usage: scripts/backup.sh [--db PATH] [--dest DIR] [--keep 30]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$ROOT/.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON=python3
cd "$ROOT"
exec "$PYTHON" -m cadence.backup "$@"
