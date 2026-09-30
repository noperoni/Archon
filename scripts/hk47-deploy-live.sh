#!/usr/bin/env bash
# HK-47 fork: move the live console to a committed revision.
#
# The console used to run `bun --watch` on this dev tree, so every saved file
# restarted it and cut every turn in flight (42 restarts on 2026-09-29, each one
# a lost question or a lost reply). The live console now runs from a detached
# worktree at ~/.archon/live that nothing edits; this script is the only thing
# that moves it.
#
#   scripts/hk47-deploy-live.sh            deploy the hk47 branch head
#   scripts/hk47-deploy-live.sh <rev>      deploy (or roll back to) any revision
#   scripts/hk47-deploy-live.sh --force    deploy even while turns are running
set -euo pipefail

LIVE="${ARCHON_LIVE:-$HOME/.archon/live}"
API="http://127.0.0.1:${PORT:-53090}"
force=0
rev=hk47
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) rev="$arg" ;;
  esac
done

target=$(git -C "$LIVE" rev-parse --verify "$rev^{commit}")
current=$(git -C "$LIVE" rev-parse HEAD)
echo "live: ${current:0:8} -> ${target:0:8} ($(git -C "$LIVE" log -1 --format=%s "$target"))"

# A restart still severs every running turn. Refuse while any is in flight.
stats=$(curl -fsS --max-time 3 "$API/health/concurrency" || echo '{}')
active=$(printf '%s' "$stats" | sed -n 's/.*"active":\([0-9]*\).*/\1/p')
queued=$(printf '%s' "$stats" | sed -n 's/.*"queuedTotal":\([0-9]*\).*/\1/p')
if [[ "${active:-0}" != 0 || "${queued:-0}" != 0 ]] && ((!force)); then
  echo "refused: ${active:-?} turn(s) running, ${queued:-?} queued; a restart would cut them. Wait, or pass --force." >&2
  exit 1
fi

git -C "$LIVE" checkout --quiet --detach "$target"
(cd "$LIVE" && bun install --frozen-lockfile)
# tsc --noEmit gates the web build, so a type error stops the deploy here,
# before anything restarts. Roll back the checkout if it does.
if ! (cd "$LIVE/packages/web" && bun run build); then
  echo "build failed; live tree returned to ${current:0:8}, services untouched" >&2
  git -C "$LIVE" checkout --quiet --detach "$current"
  exit 1
fi

# The units themselves live outside the repo and may have changed too.
systemctl --user daemon-reload
systemctl --user restart archon-server.service archon-web.service
for _ in $(seq 30); do
  curl -fsS --max-time 2 "$API/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 "$API/health" >/dev/null || { echo "server not healthy after restart" >&2; exit 1; }
echo "live at ${target:0:8}; roll back with: $0 ${current:0:8}"
