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

# Print one pipe-separated line per repo: id|url|ref|localPath
# Pipe is used (not tab) because bash `read` collapses adjacent IFS-whitespace
# even with explicit IFS — so an empty `gitUrl` field would be eaten.
ENTRIES=$(node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const r of data.repos) console.log([r.id, r.gitUrl, r.ref, r.localPath || ""].join("|"));
' "$MANIFEST")

count=$(echo "$ENTRIES" | grep -c '^' || true)
echo "Fetching $count real-world repos into $TARGET_ROOT"

PARALLEL="${FETCH_PARALLEL:-4}"
pids=()
running=0
failed=0

clone_one() {
    local id="$1" url="$2" ref="$3" localPath="$4"
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

    if [ -d "$target/.git" ]; then
        echo "[skip] $id already cloned"
        return 0
    fi
    echo "[clone] $id <- $url ($ref)"
    if git clone --depth=1 --branch="$ref" --single-branch --quiet "$url" "$target" 2>/dev/null; then
        echo "[done]  $id"
        return 0
    fi
    # Fall back to default branch if --branch failed (ref might be a tag we don't have, etc.)
    rm -rf "$target"
    if git clone --depth=1 --quiet "$url" "$target" 2>/dev/null; then
        echo "[WARN]  $id fell back to default branch (requested ref '$ref' not directly cloneable as a shallow target)" >&2
        echo "[done]  $id (default branch)"
        return 0
    fi
    echo "[FAIL]  $id <- $url" >&2
    return 1
}

while IFS='|' read -r id url ref localPath; do
    [ -z "$id" ] && continue
    clone_one "$id" "$url" "$ref" "$localPath" &
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
