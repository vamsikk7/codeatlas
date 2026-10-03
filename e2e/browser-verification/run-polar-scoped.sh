#!/usr/bin/env bash
# run-polar-scoped.sh — drive the full 147-case polar-scoped capture in bounded
# chunks (each chunk stays well under any per-command timeout). Safe to re-run;
# the stateful DIFF/REVIEW cases perturb real source via {editFile} and
# auto-revert (exact-byte) — polar is never left dirty (a SIGTERM handler in
# capture.mjs reverts even on a kill).
#
#   bash e2e/browser-verification/run-polar-scoped.sh [BUILD] [CHUNK]
#
# Prereqs: a live CodeAtlas VSIX dashboard serving polar at :7742.
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
BUILD="${1:-polar-full}"
CHUNK="${2:-5}"                     # DIFF/REVIEW cases per chunk (~5 ≈ 6 min, fits a 10-min limit).
                                   # Each stateful case ≈ 60-70s (edit → server cascade → shots → revert).
                                   # Run under a real batch timeout, NOT a 10-min-capped shell.
URL="http://localhost:7742"
SUITE=e2e/browser-verification/polar-scoped.suite.json
ACT=e2e/browser-verification/polar-scoped.actions.json
OUT="tmp/verification-runs/$BUILD/polar-scoped"
run() { echo ">>> $*"; node e2e/browser-verification/capture.mjs --suite "$SUITE" --url "$URL" --build "$BUILD" --out "$OUT" --actions "$ACT" "$@"; }

count() { node -e "const s=require('./$SUITE');const x=s.suites.find(y=>y.id==='$1');console.log(x?x.cases.length:0)"; }

# Reload the VS Code extension host + wait until 7742 is back and CPU settles.
# WHY: each stateful case fires TWO server cascades (edit + revert). On a heavy
# repo (polar server = 326MB) the extension host degrades after ~10 edit/revert
# cycles — CPU pegs at ~120%, RSS climbs past 1GB, and each cascade balloons from
# ~60s to minutes. A reload every RELOAD_EVERY chunks resets it. Skip on light
# repos by setting RELOAD_EVERY=0.
RELOAD_EVERY="${RELOAD_EVERY:-2}"
reload_exthost() {
  echo ">>> reloading VS Code (clear cascade degradation)"
  osascript -e 'quit app "Visual Studio Code"' 2>/dev/null; sleep 4
  code "$POLAR_WS" >/dev/null 2>&1
  for i in $(seq 1 50); do curl -s -o /dev/null -w '%{http_code}' "$URL/index.html" 2>/dev/null | grep -q 200 && break; sleep 3; done
  for i in $(seq 1 15); do c=$(ps aux 2>/dev/null | grep -iE 'Code Helper.*Plugin|extensionHost' | grep -v grep | awk '{s+=$3} END{print int(s)}'); [ "${c:-100}" -lt 25 ] && break; sleep 4; done
}
POLAR_WS="${POLAR_WS:-/home/dev/work/personal/polar}"

# fast, stateless suites first (idempotent — safe to re-run)
run --suites WALK --features 8
run --suites ENTRYTYPES
run --suites REPLAY

# stateful suites in chunks (edit → cascade → shot → revert), reloading between
# chunks so the extension host never degrades into minute-long cascades.
for suite in DIFF AIREVIEW; do
  n=$(count "$suite"); off=0; ci=0
  while [ "$off" -lt "$n" ]; do
    run --suites "$suite" --offset "$off" --limit "$CHUNK"
    off=$((off + CHUNK)); ci=$((ci + 1))
    if [ "$RELOAD_EVERY" -gt 0 ] && [ "$off" -lt "$n" ] && [ $((ci % RELOAD_EVERY)) -eq 0 ]; then reload_exthost; fi
  done
done

echo "=== done. screenshots: $(find "$OUT" -name '*.png' | wc -l | tr -d ' ') ==="
echo "=== polar dirty check (must be empty): ==="
git -C /home/dev/work/personal/polar status --short | grep -v '.codeatlas/' || echo "(clean)"
