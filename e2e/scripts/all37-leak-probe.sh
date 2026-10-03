#!/usr/bin/env bash
# all37-leak-probe.sh — Issue #727 final piece.
#
# Per-layer cascade leak probe across the 37 real-project fixtures
# cloned by `npm run fetch:real-projects`. For each repo:
#   1. Quit VS Code, wipe <repo>/.codeatlas/, open `code <repo>`.
#   2. Wait for state.db `files` row count to stabilize for 3 ticks.
#   3. Auto-pick an editable function from any L4 file graph (`type=function`
#      node, language extension matches, body opener via `\bname\s*\(`).
#   4. Apply a language-specific REAL-STATEMENT edit via the per-language
#      template map below. Comments don't trigger L5 flow node changes.
#   5. Wait 7s. SQL-probe per-layer modified counts (L1/L2a/L2b/L3/L4/L5).
#   6. Revert via `mv .cabak`. Wait 7s. SQL-probe per-layer leakage counts.
#   7. Quit VS Code.
#
# Emits one stdout line per repo in the canonical format consumed by the
# `live-verify` skill:
#
#   <repo-id> files=N apis=N svc=N clu=N pick=<file>::<fn> \
#     postE=L1:n/L2a:n/L2b:n/L3:n/L4:n/L5:n \
#     revL=L1:n/L2a:n/L2b:n/L3:n/L4:n/L5:n \
#     verdict={PASS|FAIL_REVERT_NOT_CLEAN|FAIL_NO_CASCADE|EDIT_FAIL|NO_PICK}
#
# Invoke as:
#   bash e2e/scripts/all37-leak-probe.sh <repo-id> [<repo-id> ...]
#   bash e2e/scripts/all37-leak-probe.sh --all
#
# Bash's foreground budget is ~10 min, so the orchestrator runs in 3-repo
# batches (see `.claude/skills/live-verify/SKILL.md` for the loop driver).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/e2e/real-repos"
SETTLE_SECS=7
READY_TICKS=3
READY_INTERVAL=1.5

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "ERROR: sqlite3 not found — install it (e.g. brew install sqlite)" >&2
    exit 2
fi
if ! command -v code >/dev/null 2>&1; then
    echo "ERROR: code (VS Code CLI) not found on PATH" >&2
    exit 2
fi

# ─── Language → editable-statement template ──────────────────────────────
# The template is a single real statement that:
#   1. Does not affect program semantics (no side effects, no exceptions).
#   2. Triggers L5 flow node count changes (comments don't).
#   3. Compiles / lints under the language's defaults.
#
# Each template uses a `_codeatlas_probe = <random>` shape so successive
# probes never collide on the same source file across cycles.
language_edit_template() {
    local ext="$1" probe_val="$2"
    case "$ext" in
        ts|tsx|js|jsx) printf '  const _codeatlas_probe_%s = "%s";\n' "$probe_val" "$probe_val";;
        py)            printf '    _codeatlas_probe_%s = "%s"\n' "$probe_val" "$probe_val";;
        go)            printf '\tvar _codeatlas_probe_%s = "%s"\n\t_ = _codeatlas_probe_%s\n' "$probe_val" "$probe_val" "$probe_val";;
        rs)            printf '    let _codeatlas_probe_%s = "%s";\n' "$probe_val" "$probe_val";;
        rb)            printf '    _codeatlas_probe_%s = "%s"\n' "$probe_val" "$probe_val";;
        php)           printf '        $_codeatlas_probe_%s = "%s";\n' "$probe_val" "$probe_val";;
        java|kt)       printf '        String _codeatlas_probe_%s = "%s";\n' "$probe_val" "$probe_val";;
        swift|dart)    printf '    let _codeatlas_probe_%s = "%s"\n' "$probe_val" "$probe_val";;
        cs)            printf '        string _codeatlas_probe_%s = "%s";\n' "$probe_val" "$probe_val";;
        *)             return 1;;
    esac
}

# ─── State.db row-count readiness check ──────────────────────────────────
# Re-poll the `files` row count every ${READY_INTERVAL}s. When the count
# stays constant for ${READY_TICKS} consecutive ticks, init is settled.
wait_for_state_ready() {
    local db="$1" last="-1" same=0
    for _ in $(seq 1 40); do
        if [[ ! -f "$db" ]]; then sleep "$READY_INTERVAL"; continue; fi
        local n
        n=$(sqlite3 "$db" "SELECT COUNT(*) FROM files;" 2>/dev/null || echo "0")
        if [[ "$n" == "$last" && "$n" != "0" ]]; then
            same=$((same + 1))
            if [[ "$same" -ge "$READY_TICKS" ]]; then return 0; fi
        else
            same=0
            last="$n"
        fi
        sleep "$READY_INTERVAL"
    done
    return 1
}

# ─── Per-layer modified-count probe ──────────────────────────────────────
# Counts the number of graph documents that contain ANY `"modified"` diff
# token at any depth in the graph_json. Cheap + matches the live-verify
# protocol's "did the cascade flip this layer?" semantic.
probe_layer_counts() {
    local db="$1"
    local -a layers=("microservice:%" "feature:%" "api-list:%" "sequence:%" "file:%" "flow:%")
    local -a keys=(L1 L2a L2b L3 L4 L5)
    local out=""
    for i in "${!layers[@]}"; do
        local n
        n=$(sqlite3 "$db" "SELECT COUNT(*) FROM graphs WHERE snapshot_kind='working' AND graph_id LIKE '${layers[$i]}' AND graph_json LIKE '%\"modified\"%';" 2>/dev/null || echo "0")
        out+="${keys[$i]}:${n}"
        [[ $i -lt 5 ]] && out+="/"
    done
    printf '%s' "$out"
}

# ─── Auto-pick a real function from any L4 file graph ────────────────────
# Reads the first `flow:<file>:<fn>` graphId whose <file> matches a known
# language extension. Echoes "<file>::<fn>" on stdout, or empty when no
# candidate is found. The L5 flow id format guarantees the function maps
# to a real body in the source — that's the whole point of having a
# flow graph for it.
auto_pick_function() {
    local db="$1"
    # Issue #782: bump the row scan size and skip non-source dirs that
    # the cascade typically doesn't watch (examples / cookbook / docs /
    # benchmarks / tests / e2e / generated). Picking from these paths
    # produces FAIL_NO_CASCADE noise that masks real revert leaks.
    # Pull more candidates so the filtered set still yields a picker.
    sqlite3 "$db" "SELECT graph_id FROM graphs WHERE snapshot_kind='working' AND graph_id LIKE 'flow:%' LIMIT 500;" 2>/dev/null | while read -r gid; do
        # gid = `flow:<filePath>:<functionName>`
        local body="${gid#flow:}"
        local fp="${body%:*}"
        local fn="${body##*:}"
        local ext="${fp##*.}"
        case "$ext" in
            ts|tsx|js|jsx|py|go|rs|rb|php|java|kt|swift|dart|cs) ;;
            *) continue;;
        esac
        # Issue #782 — skip files under known non-source dirs.
        case "$fp" in
            *_examples/*|*/_examples/*|_examples/*) continue;;
            *examples/*|*/examples/*|examples/*) continue;;
            *samples/*|*/samples/*|samples/*) continue;;
            *cookbook/*|*/cookbook/*|cookbook/*) continue;;
            *benchmarks/*|*/benchmarks/*|benchmarks/*) continue;;
            *docs/*|*/docs/*|docs/*) continue;;
            *assets/*|*/assets/*|assets/*) continue;;
            *.e2e/*|*/\.e2e/*|.e2e/*) continue;;
            *__tests__/*|*/__tests__/*|__tests__/*) continue;;
            *__fixtures__/*|*/__fixtures__/*|__fixtures__/*) continue;;
            */tests/*|tests/*) continue;;
            */test/*|test/*) continue;;
            */e2e/*|e2e/*) continue;;
            *.test.*|*.spec.*) continue;;
        esac
        # Strip class prefix from labels (`ClassName.method` → `method`)
        # so the source-body grep finds the actual definition.
        fn="${fn##*.}"
        printf '%s::%s\n' "$fp" "$fn"
        return 0
    done | head -1
}

# ─── Per-repo run ────────────────────────────────────────────────────────
run_repo() {
    local repo_id="$1"
    local repo="${FIXTURES_DIR}/${repo_id}"
    if [[ ! -d "$repo" ]]; then
        echo "${repo_id} verdict=NOT_CLONED rc=2"
        return
    fi
    osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
    sleep 2

    rm -rf "${repo}/.codeatlas"
    code "$repo" >/dev/null 2>&1 &
    local code_pid=$!
    local db="${repo}/.codeatlas/state.db"

    if ! wait_for_state_ready "$db"; then
        echo "${repo_id} verdict=INIT_TIMEOUT rc=3"
        osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
        return
    fi

    # Issue #783: snapshot-kind filter — every fixture has BOTH
    # `baseline` and `working` rows in these tables, so a bare COUNT(*)
    # double-counts every entity (services, clusters, etc.). The
    # leak-probe header is meant to mirror the home-page numbers a user
    # sees in the browser, which are working-snapshot only.
    local files apis svc clu pick
    files=$(sqlite3 "$db" "SELECT COUNT(*) FROM files WHERE snapshot_kind='working';" 2>/dev/null || echo "0")
    apis=$(sqlite3 "$db" "SELECT COUNT(*) FROM apis WHERE snapshot_kind='working';" 2>/dev/null || echo "0")
    svc=$(sqlite3 "$db" "SELECT COUNT(*) FROM services WHERE snapshot_kind='working';" 2>/dev/null || echo "0")
    clu=$(sqlite3 "$db" "SELECT COUNT(*) FROM clusters WHERE snapshot_kind='working';" 2>/dev/null || echo "0")
    pick=$(auto_pick_function "$db")

    if [[ -z "$pick" ]]; then
        echo "${repo_id} files=${files} apis=${apis} svc=${svc} clu=${clu} verdict=NO_PICK"
        osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
        return
    fi

    local fp="${pick%::*}" fn="${pick##*::}"
    local target="${repo}/${fp}"
    local ext="${fp##*.}"
    local probe_val=$RANDOM
    if [[ ! -f "$target" ]]; then
        echo "${repo_id} files=${files} apis=${apis} svc=${svc} clu=${clu} pick=${pick} verdict=EDIT_FAIL rc=missing_file"
        osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
        return
    fi

    # Find the function body opener line. Match `<fn>(`, `def <fn>(`, etc.
    # BSD awk (macOS default) does NOT support `\b` word boundaries; use
    # explicit non-word-char sentinels instead. The leading `(^|[^A-Za-z0-9_])`
    # ensures we don't match `XhasYarn` when looking for `hasYarn`, and the
    # trailing `[(:]` matches the call paren / Python def colon.
    local body_line
    body_line=$(awk -v fn="$fn" '
        $0 ~ ("(^|[^A-Za-z0-9_])" fn "[^A-Za-z0-9_]*[(:]") { print NR; exit }
    ' "$target")
    if [[ -z "$body_line" ]]; then
        echo "${repo_id} files=${files} apis=${apis} svc=${svc} clu=${clu} pick=${pick} verdict=EDIT_FAIL rc=no_body_line"
        osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
        return
    fi

    cp "$target" "${target}.cabak"
    local insert
    if ! insert=$(language_edit_template "$ext" "$probe_val"); then
        echo "${repo_id} files=${files} apis=${apis} svc=${svc} clu=${clu} pick=${pick} verdict=EDIT_FAIL rc=no_template:${ext}"
        mv "${target}.cabak" "$target"
        osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true
        return
    fi
    # Insert right after the body opener line.
    awk -v line="$body_line" -v insert="$insert" '
        NR==line { print; printf "%s", insert; next }
        { print }
    ' "$target" > "${target}.tmp" && mv "${target}.tmp" "$target"

    sleep "$SETTLE_SECS"
    local postE
    postE=$(probe_layer_counts "$db")

    mv "${target}.cabak" "$target"
    sleep "$SETTLE_SECS"
    local revL
    revL=$(probe_layer_counts "$db")

    osascript -e 'tell application "Visual Studio Code" to quit' >/dev/null 2>&1 || true

    # Verdict logic (mirrors the live-verify protocol):
    #  - If postE is all zeros → no cascade fired → EDIT_FAIL.
    #  - If revL is all zeros → clean revert → PASS.
    #  - Otherwise some layer leaked → FAIL_REVERT_NOT_CLEAN.
    local verdict="PASS"
    if [[ "$postE" == "L1:0/L2a:0/L2b:0/L3:0/L4:0/L5:0" ]]; then
        verdict="FAIL_NO_CASCADE"
    elif [[ "$revL" != "L1:0/L2a:0/L2b:0/L3:0/L4:0/L5:0" ]]; then
        verdict="FAIL_REVERT_NOT_CLEAN"
    fi

    echo "${repo_id} files=${files} apis=${apis} svc=${svc} clu=${clu} pick=${pick} postE=${postE} revL=${revL} verdict=${verdict}"
}

main() {
    if [[ $# -eq 0 ]]; then
        echo "Usage: $0 <repo-id> [<repo-id> ...]  OR  $0 --all" >&2
        exit 2
    fi
    if [[ "$1" == "--all" ]]; then
        for d in "$FIXTURES_DIR"/*/; do
            run_repo "$(basename "$d")"
        done
    else
        for repo_id in "$@"; do
            run_repo "$repo_id"
        done
    fi
}

main "$@"
