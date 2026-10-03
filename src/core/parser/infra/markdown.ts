/**
 * infra/markdown.ts — Issue #712 wiki / knowledge-base parser.
 *
 * Extracts structural metadata from one markdown file:
 *   - Title (first H1) → record name
 *   - Headings (H2-H6) → meta.headings (used by the renderer for outline view)
 *   - Wikilinks `[[Other Doc]]` → outbound references to other wiki docs
 *   - Plain markdown links `[label](other.md)` → relative-path references
 *   - Code references — `path/to/file.ext`, `Foo.bar()`, ``` `Foo` ```
 *
 * The parser is regex-based (no full CommonMark grammar) — we only need
 * the structural anchors for a graph view, not the typography. Inline
 * code spans + fenced code blocks are stripped first so a wikilink-shaped
 * substring inside a code example doesn't fire as a real link.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

const MARKDOWN_DIRECTORIES = ['docs/', 'doc/', 'runbooks/', 'runbook/', 'adr/', 'architecture/'];

export function canParseMarkdown(filePath: string): boolean {
    if (!/\.(md|markdown|mdx)$/i.test(filePath)) return false;
    // Only emit wiki records for files in conventional doc directories.
    // Code repos often have a top-level README.md or per-package CHANGELOG.md
    // that we DON'T want to ingest into the wiki graph — they're noise.
    const lower = filePath.toLowerCase();
    if (lower === 'readme.md' || lower.endsWith('/readme.md')) return false;
    if (lower === 'changelog.md' || lower.endsWith('/changelog.md')) return false;
    return MARKDOWN_DIRECTORIES.some(d => lower.startsWith(d) || lower.includes('/' + d));
}

export function parseMarkdown(filePath: string, source: string): InfraRecord[] {
    // Strip fenced code blocks + inline code spans BEFORE link/wikilink
    // extraction so we don't pick up false positives.
    const stripped = source
        .replace(/```[\s\S]*?```/g, '\n') // fenced code blocks → newline (preserves line numbers)
        .replace(/`[^`\n]+`/g, ''); // inline code spans

    const lines = stripped.split('\n');
    const title = extractTitle(lines) ?? path.basenameNoExt(filePath);
    const headings = extractHeadings(lines);
    const outbound = extractOutboundRefs(stripped, filePath);
    const codeRefs = extractCodeRefs(stripped);

    const anchor: Anchor = {
        filePath,
        symbol: title,
        span: { start: 0, end: Math.min(source.length, 1) },
    };

    const id = `infra:wiki-doc:${filePath}`;
    return [{
        id,
        kind: 'wiki-doc',
        name: title,
        filePath,
        anchor,
        dependencies: outbound.length > 0 ? outbound : undefined,
        meta: {
            headings,
            wordCount: stripped.split(/\s+/).filter(Boolean).length,
            codeRefs: codeRefs.length > 0 ? codeRefs : undefined,
        },
    }];
}

function extractTitle(lines: string[]): string | null {
    for (const line of lines) {
        const m = /^#\s+(.+?)\s*$/.exec(line);
        if (m) return m[1].trim();
    }
    return null;
}

function extractHeadings(lines: string[]): Array<{ level: number; text: string }> {
    const out: Array<{ level: number; text: string }> = [];
    for (const line of lines) {
        const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
        if (m) out.push({ level: m[1].length, text: m[2].trim() });
    }
    return out;
}

/**
 * Outbound references in the document:
 *   - `[[Wiki Style Link]]` → infra:wiki-doc:<slug>
 *   - `[label](other.md)` → resolved relative to this doc's directory
 *   - `[label](./sub/dir/note.md)` → same
 *
 * Wikilink anchors resolve client-side; we just record the target title.
 * Markdown-link refs become file paths so the renderer can deep-link to
 * the file graph (L4) when the user clicks them.
 */
function extractOutboundRefs(source: string, filePath: string): string[] {
    const refs = new Set<string>();

    // Wikilinks
    const wikilinkRe = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikilinkRe.exec(source)) !== null) {
        const target = m[1].trim();
        if (target.length === 0) continue;
        const slug = target.toLowerCase().replace(/\s+/g, '-');
        refs.add(`infra:wiki-doc:${slug}`);
    }

    // Markdown links to other markdown files
    const mdLinkRe = /\[[^\]]+\]\(([^)\s]+\.(?:md|markdown|mdx))(?:\s+"[^"]*")?\)/g;
    while ((m = mdLinkRe.exec(source)) !== null) {
        const rel = m[1];
        if (rel.startsWith('http://') || rel.startsWith('https://')) continue;
        const resolved = resolveRelative(filePath, rel);
        refs.add(`infra:wiki-doc:${resolved}`);
    }

    return [...refs].filter(r => r !== `infra:wiki-doc:${filePath}`);
}

/**
 * Code references — `path/to/file.ext` mentions and symbol-shaped
 * patterns. Used by the renderer to draw cross-edges from wiki nodes
 * to code nodes (file graphs / sequence graphs).
 */
function extractCodeRefs(source: string): string[] {
    const refs = new Set<string>();
    // File-path mentions: `src/auth/login.ts`, `apps/web/page.tsx`, etc.
    // Conservative — require ≥ 2 path segments + a known code extension.
    const filePathRe = /\b((?:[a-zA-Z0-9_-]+\/){1,})[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|py|java|kt|go|rs|rb|php|swift|dart|cs|cpp|c|h)\b/g;
    let m: RegExpExecArray | null;
    while ((m = filePathRe.exec(source)) !== null) {
        refs.add(m[0]);
    }
    return [...refs];
}

function resolveRelative(from: string, rel: string): string {
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    // Minimal path resolution that handles `./` and `../`. Avoids
    // pulling in Node's `path` module so this stays bundler-friendly
    // even when the parser runs in the browser surface.
    const parts = (fromDir ? fromDir.split('/') : []).filter(Boolean);
    for (const seg of rel.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg === '.' || seg === '') continue;
        else parts.push(seg);
    }
    return parts.join('/');
}

// Standalone helpers (no Node `path` dependency — we ship inside both
// the standalone server and the webview bundle, where `path` may or may
// not be polyfilled).
const path = {
    basenameNoExt(p: string): string {
        const last = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        const dot = last.lastIndexOf('.');
        return dot > 0 ? last.slice(0, dot) : last;
    },
};
