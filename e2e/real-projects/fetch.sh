#!/usr/bin/env bash
# Shallow-clones each repo listed in repos.json into e2e/real-repos/<id>/.
# Idempotent: skips repos that are already cloned.
# Used by `npm run fetch:real-projects` and `npm run verify:real`.
#
# Uses `node` to parse repos.json (no jq dependency).

set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/e2e/real-projects/repos.json"
TARGET_ROOT="$ROOT/e2e/real-repos"

if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is required" >&2
    exit 1
fi

mkdir -p "$TARGET_ROOT"

# Print one pipe-separated line per repo: id|url|ref|localPath|sha
# Pipe is used (not tab) because bash `read` collapses adjacent IFS-whitespace
# even with explicit IFS — so an empty `gitUrl` field would be eaten.
ENTRIES=$(node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const r of data.repos) console.log([r.id, r.gitUrl, r.ref, r.localPath || "", r.sha || ""].join("|"));
' "$MANIFEST")

count=$(echo "$ENTRIES" | grep -c '^' || true)
echo "Fetching $count real-world repos into $TARGET_ROOT"

PARALLEL="${FETCH_PARALLEL:-4}"
pids=()
running=0
failed=0

clone_one() {
    local id="$1" url="$2" ref="$3" localPath="$4" sha="$5"
    local target="$TARGET_ROOT/$id"

    # Local-path entries: symlink instead of clone. Idempotent.
    if [ -n "$localPath" ]; then
        # Expand leading ~ to $HOME
        local expanded="${localPath/#\~/$HOME}"
        if [ ! -d "$expanded" ]; then
            echo "[FAIL]  $id <- localPath $expanded does not exist" >&2
            return 1
        fi
        if [ -L "$target" ] && [ "$(readlink "$target")" = "$expanded" ]; then
            echo "[skip] $id already linked"
            return 0
        fi
        rm -rf "$target"
        ln -s "$expanded" "$target"
        echo "[link]  $id -> $expanded"
        return 0
    fi

    # An existing clone is only reusable if it sits on the pinned commit.
    # Previously this skipped on the mere presence of .git, which is how the
    # corpus silently drifted five months away from the recorded baseline
    # while every run still reported "[skip] already cloned".
    if [ -d "$target/.git" ]; then
        local have
        have="$(git -C "$target" rev-parse HEAD 2>/dev/null || echo '')"
        if [ -z "$sha" ]; then
            echo "[skip] $id already cloned (no sha pinned — pin it in repos.json)"
            return 0
        fi
        if [ "$have" = "$sha" ]; then
            # Remove CodeAtlas's own state dirs so a re-run starts from the
            # same tree the baseline was recorded against.
            rm -rf "$target/.codeatlas" "$target/.codeatlas-sa" 2>/dev/null || true
            echo "[skip] $id already at pinned ${sha:0:10}"
            return 0
        fi
        echo "[REPIN] $id at ${have:0:10}, want ${sha:0:10} — refetching"
        rm -rf "$target"
    fi

    if [ -n "$sha" ]; then
        # Fetch the exact commit. GitHub serves any commit reachable from a
        # ref, so this works for history that has moved on since pinning.
        echo "[clone] $id <- $url @ ${sha:0:10}"
        mkdir -p "$target"
        if git -C "$target" init -q 2>/dev/null \
           && git -C "$target" remote add origin "$url" 2>/dev/null \
           && git -C "$target" fetch -q --depth=1 origin "$sha" 2>/dev/null \
           && git -C "$target" checkout -q FETCH_HEAD 2>/dev/null; then
            echo "[done]  $id @ ${sha:0:10}"
            return 0
        fi
        echo "[FAIL]  $id <- $url @ $sha (commit unreachable — re-pin from repos.json)" >&2
        rm -rf "$target"
        return 1
    fi

    # Unpinned fallback. Kept so a newly added repo can be cloned before its
    # sha is recorded, but it is NOT reproducible — pin it before baselining.
    echo "[clone] $id <- $url ($ref, UNPINNED)"
    if git clone --depth=1 --branch="$ref" --single-branch --quiet "$url" "$target" 2>/dev/null; then
        echo "[WARN]  $id cloned unpinned; record its sha in repos.json" >&2
        return 0
    fi
    rm -rf "$target"
    if git clone --depth=1 --quiet "$url" "$target" 2>/dev/null; then
        echo "[WARN]  $id fell back to default branch; ref '$ref' is wrong and no sha is pinned" >&2
        return 0
    fi
    echo "[FAIL]  $id <- $url" >&2
    return 1
}

while IFS='|' read -r id url ref localPath sha; do
    [ -z "$id" ] && continue
    clone_one "$id" "$url" "$ref" "$localPath" "$sha" &
    pids+=($!)
    running=$((running + 1))
    if [ "$running" -ge "$PARALLEL" ]; then
        wait "${pids[0]}" || failed=$((failed + 1))
        pids=("${pids[@]:1}")
        running=$((running - 1))
    fi
done <<< "$ENTRIES"

for pid in "${pids[@]}"; do
    wait "$pid" || failed=$((failed + 1))
done

echo ""
if [ "$failed" -ne 0 ]; then
    echo "$failed repo(s) failed to clone. Re-run to retry only the missing ones." >&2
fi
echo "Disk usage:"
du -sh "$TARGET_ROOT" 2>/dev/null || true

[ "$failed" -eq 0 ]
