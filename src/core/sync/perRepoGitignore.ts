/**
 * UX-71 (2026-06-09) — per-repo `.gitignore` → WorkspaceWatcher globs.
 *
 * Each sub-repo may declare its own ignore patterns (build artifacts,
 * vendor dirs, language-specific output folders). Today the
 * WorkspaceWatcher only honours a fixed workspace-root ignore list,
 * so e.g. a sub-repo's `target/` (Rust/Java) or `out/` (Next.js) leaks
 * into the watcher and triggers spurious cascade rebuilds. The helper
 * here reads each detected sub-repo's `.gitignore`, normalises the
 * patterns to chokidar-compatible globs scoped under the sub-repo's
 * `rootPath`, and returns them ready to merge.
 *
 * Tests: `__tests__/perRepoGitignore.test.ts`.
 */

export interface GitignoreSource {
    /** Sub-repo rootPath relative to workspaceRoot, e.g. `service-a`. */
    rootPath: string;
    /** Raw `.gitignore` contents, or `null` when the file was absent. */
    text: string | null | undefined;
}

/**
 * Parse `.gitignore` text into a flat list of patterns. Drops comments,
 * blank lines, negations (we never want to UN-ignore what the user
 * explicitly listed), trailing slashes, and surrounding whitespace.
 */
export function parseGitignoreLines(text: string | null | undefined): string[] {
    if (!text) return [];
    return text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .filter(line => !line.startsWith('#'))
        .filter(line => !line.startsWith('!'))
        .map(line => line.replace(/\/$/, ''));
}

/**
 * Convert a list of per-repo `.gitignore` sources into chokidar-style
 * globs scoped under each sub-repo's `rootPath`. Sources with empty
 * `rootPath` are skipped (the workspace-root .gitignore is handled by
 * the workspace-level watcher init).
 *
 * Output convention:
 *   - bare directory patterns become `<root>/**\/<dir>/**`
 *   - bare file patterns become `<root>/**\/<file>`
 *   - wildcard patterns become `<root>/**\/<pattern>`
 *   - nested paths become `<root>/**\/<nested>/**`
 *
 * The `**` prefix means the pattern matches at any depth under the
 * sub-repo's root, which is the semantic git itself uses for non-
 * anchored patterns.
 */
export function perRepoGitignoreToGlobs(sources: ReadonlyArray<GitignoreSource>): string[] {
    const out: string[] = [];
    for (const src of sources) {
        if (!src.rootPath) continue;
        const lines = parseGitignoreLines(src.text);
        for (const pat of lines) {
            // File-glob patterns (wildcards present) don't need a trailing
            // `/**`; they match files at any depth.
            const isFileGlob = /[*?[]/.test(pat) && !pat.endsWith('/');
            if (isFileGlob) {
                out.push(`${src.rootPath}/**/${pat}`);
            } else {
                out.push(`${src.rootPath}/**/${pat}/**`);
            }
        }
    }
    return out;
}
