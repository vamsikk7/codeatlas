#!/usr/bin/env bash
#
# yc-demo.sh — drive a 4-minute CodeAtlas walkthrough on the
# node-express-realworld-example-app (Conduit) cloned at
# e2e/real-repos/ts-express-realworld.
#
# WHAT IT DOES
#   1. Verifies the demo repo is cloned (offers to fetch if missing).
#   2. Builds CodeAtlas (so the latest detector/extractor changes are in dist).
#   3. Wipes any prior state.json on the demo repo for a clean cold start.
#   4. Pre-warms the pipeline so the live demo opens instantly with diagrams ready.
#   5. Prints a 4-minute talk-track with exact click paths for the YC demo.
#
# USAGE
#   ./scripts/yc-demo.sh                  # default: ts-express-realworld
#   ./scripts/yc-demo.sh js-express       # any other repo id under e2e/real-repos/
#   ./scripts/yc-demo.sh --no-prewarm     # skip the pre-warm step (cold demo)
#   ./scripts/yc-demo.sh --reset          # wipe state and exit (no rebuild)
#

set -euo pipefail

REPO_ID="${1:-ts-express-realworld}"
[[ "${REPO_ID}" == --* ]] && REPO_ID="ts-express-realworld"

DO_PREWARM=1
DO_RESET_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --no-prewarm) DO_PREWARM=0 ;;
        --reset)      DO_RESET_ONLY=1 ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_PATH="${ROOT}/e2e/real-repos/${REPO_ID}"
NODE_BIN="${HOME}/.nvm/versions/node/v22.19.0/bin"
[[ -d "${NODE_BIN}" ]] && export PATH="${NODE_BIN}:${PATH}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
ok()    { printf "\033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m!\033[0m %s\n" "$*"; }
step()  { printf "\n\033[36m▸ %s\033[0m\n" "$*"; }

bold "CodeAtlas YC Demo Driver"
dim  "Repo: ${REPO_ID}"
dim  "Path: ${REPO_PATH}"

# ── Repo presence check ─────────────────────────────────────────────────
if [[ ! -d "${REPO_PATH}" ]]; then
    warn "Demo repo not cloned at ${REPO_PATH}"
    echo  "  Run: npm run fetch:real-projects"
    exit 1
fi
ok "Demo repo present"

# ── Reset-only path ─────────────────────────────────────────────────────
if (( DO_RESET_ONLY )); then
    rm -rf "${REPO_PATH}/.codeatlas"
    ok "Wiped ${REPO_PATH}/.codeatlas"
    exit 0
fi

# ── Build extension ─────────────────────────────────────────────────────
step "Building extension (so latest detectors are in dist/)"
cd "${ROOT}"
npm run package > /tmp/yc-demo-build.log 2>&1 \
    && ok "Build succeeded" \
    || { warn "Build failed — see /tmp/yc-demo-build.log"; exit 2; }

# ── Cold-start reset ────────────────────────────────────────────────────
step "Wiping prior state on demo repo (cold-start guarantee)"
rm -rf "${REPO_PATH}/.codeatlas"
ok    "Demo repo is now in pristine state"

# ── Pre-warm ────────────────────────────────────────────────────────────
if (( DO_PREWARM )); then
    step "Pre-warming pipeline (state.json will be ready when you open VS Code)"
    npx tsx scripts/dump-one-repo.ts "${REPO_ID}" 2>&1 | tail -6
    ok "Pre-warm complete"

    if [[ -f "${REPO_PATH}/.codeatlas/dump-stats.json" ]]; then
        echo
        bold "Demo numbers (memorize these — useful for the live talk):"
        cat "${REPO_PATH}/.codeatlas/dump-stats.json"
    fi
fi

# ── Talk-track ──────────────────────────────────────────────────────────
cat <<'EOF'

══════════════════════════════════════════════════════════════════════════
  YC DEMO — 4-MINUTE TALK TRACK   (node-express-realworld / Conduit)
══════════════════════════════════════════════════════════════════════════

OPEN
  1. `code e2e/real-repos/ts-express-realworld`
  2. Activate CodeAtlas (sidebar icon).  Diagrams render in <2s (pre-warmed).

  Hook:  "39 files. 20 routes. 5 features. CodeAtlas built the whole
         architecture map automatically — no config, no manual annotation.
         Let me show you what a new engineer sees on day one."

L1 — SYSTEM DESIGN  (~30s)
  Show:  "One service: backend.  External infra detected: Postgres (Prisma),
         JWT.  This is the elevator-pitch view of the codebase."
  Click: any service → drills to L2a.

L2a — FEATURE AREAS  (~30s)
  Show:  5 clusters → Article Management, Auth, Profiles, Tags, User.
         "These are AI-named.  CodeAtlas grouped 39 files into the 5
         features any engineer would draw on a whiteboard."
  Click: 'Article Management' cluster.

L2b — API LIST  (~45s)
  Show:  ~9 article routes — POST /articles, GET /articles/feed,
         POST /articles/:slug/comments, etc.
  Hook:  "Notice every route has a real handler name (createArticle,
         getFeed) — even the inline arrow functions in route files.
         That's our v3.2.5 work paying off."
  Click: POST /articles → drills to L3.

L3 — SEQUENCE DIAGRAM  (~45s)
  Show:  Swimlanes for createArticle → ArticleService → Prisma →
         Postgres.  "This is the runtime story of an HTTP POST.  We
         derived it from static analysis alone — no traces, no APM."
  Click: any message arrow → drills to L5.

L5 — FLOW CHART  (~30s)
  Show:  Decision diamonds for ‘if (existingArticle) throw 422', the
         try/catch around prisma.create, the success return.
  Hook:  "This is the control flow of the handler.  Branch coverage,
         dead-code candidates, complexity hot-spots — all from this view.
         Click any function to read the source."

DIFF MODE  (~30s)  — optional, skip if running short
  Open:  Source Control → click any commit (or "Replay Working Changes").
  Show:  Diagrams highlight added/removed/modified nodes with ✓/✗/~.
  Hook:  "Code review meets architecture review.  Reviewers see what the
         change actually does to the system, not just which lines moved."

CLOSE  (~30s)
  Pitch: "The best engineering teams keep mental models in their heads.
         CodeAtlas externalises that model — automatically, every commit,
         across 30+ frameworks.  Onboarding goes from weeks to hours.
         PR review goes from 'what is this code?' to 'is this the right
         architectural change?'"

══════════════════════════════════════════════════════════════════════════
  RECOVERY MOVES (if something goes wrong)
══════════════════════════════════════════════════════════════════════════
  • Diagrams blank?         → Re-run:  ./scripts/yc-demo.sh
  • Wrong diagram opens?    → Click ⌂ home in CodeAtlas, then re-navigate.
  • VS Code slow on cold?   → Use the pre-warm; this script does it for you.
  • Want to demo a different repo?  ./scripts/yc-demo.sh js-express
EOF
