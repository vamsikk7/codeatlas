/**
 * pathUtils.ts — cross-platform path helpers.
 *
 * The extension host runs on macOS, Linux, AND Windows. Paths that originate
 * from a Windows workspace carry `\` separators and `C:\…` drive-letter roots.
 * Two POSIX-only idioms were scattered across the codebase and broke on Windows:
 *
 *   1. `p.startsWith('/') ? p : `${root}/${p}`` — a Windows absolute path
 *      (`c:\…`) does NOT start with `/`, so the workspace root got prepended,
 *      producing a DOUBLED path (`c:\root\c:\root\file.ts`) → ENOENT.
 *      (BUG-WIN-DOUBLED-PATH: L5 "Failed to build flow … no such file".)
 *   2. `filePath.split('/').pop()` for a display basename — a `\`-separated
 *      Windows path never splits, so the whole path leaked into UI labels
 *      (participant names showed `c:\Users\…`). (BUG-WIN-PARTICIPANT-PATHNAME.)
 *
 * These helpers are separator-agnostic so they behave identically regardless of
 * which OS produced the path or which OS is running the check (important: the
 * test suite runs on macOS but must verify Windows-path behaviour).
 */
import * as path from 'path';

/**
 * True when `p` is an absolute path on ANY platform: POSIX (`/…`), Windows
 * drive-letter (`C:\…` / `C:/…`), or Windows UNC (`\\server\share`).
 * Intentionally does NOT delegate to `path.isAbsolute`, which only recognises
 * the host platform's form (so a Windows path checked on macOS reads false).
 */
export function isAbsolutePath(p: string): boolean {
    if (!p) return false;
    return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * The final path segment, splitting on BOTH `/` and `\` so a Windows path
 * yields its filename rather than the whole string. Falls back to the input
 * when there is no separator.
 */
export function baseName(p: string): string {
    if (!p) return p;
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/**
 * Resolve `p` against `root`: if `p` is already absolute (on any platform),
 * return it unchanged; otherwise join it under `root` with the host separator.
 * This is the safe replacement for `p.startsWith('/') ? p : `${root}/${p}``.
 */
export function resolveUnderRoot(root: string, p: string): string {
    if (isAbsolutePath(p)) return p;
    return path.join(root, p);
}
