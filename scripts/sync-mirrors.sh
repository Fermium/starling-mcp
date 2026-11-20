#!/bin/sh
# Syncs the local Starling mirror for each profile given, one after another, then backs it up.
# Usage: scripts/sync-mirrors.sh personal business joint
# Environment:
#   STARLING_BACKUP_DIR  optional folder for daily backup copies (e.g. a Google Drive folder); never the live DB folder
#   NODE                 optional absolute path to node (launchd does not see your shell's PATH)
# Exit code: 0 all complete, 75 at least one profile stopped early (resumable), 1 an error.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
node=${NODE:-$(command -v node)}
status=0
for profile in "$@"; do
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $profile"
  if [ -n "${STARLING_BACKUP_DIR:-}" ]; then
    "$node" "$here/dist/index.js" sync --profile "$profile" --backup-dir "$STARLING_BACKUP_DIR"
  else
    "$node" "$here/dist/index.js" sync --profile "$profile"
  fi
  code=$?
  if [ "$code" -eq 75 ] && [ "$status" -eq 0 ]; then status=75; fi
  if [ "$code" -ne 0 ] && [ "$code" -ne 75 ]; then status=1; fi
done
exit "$status"
