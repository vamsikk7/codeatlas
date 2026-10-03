/**
 * exportStaticDashboard.ts — Issue #710 static dashboard export.
 *
 * Bundles a frozen workspace analysis into a static directory that any
 * HTTP server can host:
 *
 *   <outDir>/
 *     index.html        ← webview-ui static build
 *     assets/           ← webview-ui assets (CSS + JS)
 *     state.json        ← snapshotStore.getWorking() serialized
 *     findings.json     ← current AI Review findings
 *     README.md         ← "open index.html to view"
 *
 * Invoked from the MCP standalone CLI via `--export <outDir>`. Self-
 * contained — no live server, no websocket, no extension required. A
 * senior engineer can share an architecture analysis with a PM by
 * tarring this directory and pasting a link.
 *
 * The optional `--token <secret>` flag wraps the bundle so the
 * `index.html` requires the secret to render — useful when the analysis
 * is shared via an internal S3 / GitHub Pages URL. Token check is
 * client-side only (it's a sharing token, not auth).
 *
 * SECURITY: the JSON dump goes through the snapshot store's existing
 * secret-redaction pass before serialization. Source code excerpts that
 * appear in finding evidence are NOT additionally redacted — they were
 * already part of the live snapshot the user could share.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { AiReviewFindingsStore } from '../core/storage/aiReviewFindingsStore';

export interface ExportOptions {
    /** Absolute output directory. Created if it doesn't exist. */
    outDir: string;
    /** Optional sharing token. When set, the dashboard prompts for it
     *  before rendering. Client-side gate only. */
    token?: string;
    /** Where to find the webview-ui static build. Defaults to
     *  `<repo>/webview-ui/dist`. */
    webviewDist?: string;
    /** Logger — defaults to no-op. */
    log?: (msg: string) => void;
}

export interface ExportResult {
    outDir: string;
    fileCount: number;
    /** Total bytes written. Helps callers verify the < 15 MB target. */
    totalBytes: number;
    /** Set of paths the export produced, relative to `outDir`. */
    paths: string[];
}

export async function exportStaticDashboard(
    snapshotStore: SnapshotStore,
    findingsStore: AiReviewFindingsStore | undefined,
    options: ExportOptions,
): Promise<ExportResult> {
    const log = options.log ?? (() => { /* noop */ });
    const outDir = path.resolve(options.outDir);
    fs.mkdirSync(outDir, { recursive: true });

    const written: string[] = [];
    let totalBytes = 0;

    function write(relPath: string, contents: string | Buffer): void {
        const abs = path.join(outDir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, contents);
        const size = typeof contents === 'string' ? Buffer.byteLength(contents, 'utf8') : contents.length;
        totalBytes += size;
        written.push(relPath);
    }

    // ── 1. state.json (the working snapshot) ──────────────────────────────
    // SnapshotStore exposes `getWorking()` which returns the in-memory
    // Snapshot — a plain object that JSON.stringify can round-trip.
    const snapshot = snapshotStore.getWorking();
    write('state.json', JSON.stringify(snapshot, replaceMaps, 2));

    // ── 2. findings.json (current AI Review findings) ─────────────────────
    if (findingsStore && typeof (findingsStore as any).listAll === 'function') {
        try {
            const findings = (findingsStore as any).listAll();
            write('findings.json', JSON.stringify(findings, null, 2));
        } catch (err: any) {
            log(`[export] findings dump failed: ${err?.message ?? err}`);
            write('findings.json', '[]');
        }
    } else {
        write('findings.json', '[]');
    }

    // ── 3. Copy the webview-ui static build ───────────────────────────────
    const webviewDist = options.webviewDist
        ?? path.resolve(__dirname, '..', '..', 'webview-ui', 'dist');
    if (fs.existsSync(webviewDist)) {
        copyDirectoryInto(webviewDist, outDir, (rel, bytes) => {
            written.push(rel);
            totalBytes += bytes;
        });
    } else {
        log(`[export] webview dist not found at ${webviewDist} — exported state but no UI.`);
    }

    // ── 4. Token wrapper (when provided) ──────────────────────────────────
    // Inserts a small <script> at the top of index.html that prompts
    // for the token via a localStorage check. Not a security control;
    // a sharing affordance.
    if (options.token) {
        const indexAbs = path.join(outDir, 'index.html');
        if (fs.existsSync(indexAbs)) {
            const original = fs.readFileSync(indexAbs, 'utf8');
            const wrapped = injectTokenGate(original, options.token);
            fs.writeFileSync(indexAbs, wrapped);
            // size delta is tiny; don't re-tally.
        }
    }

    // ── 5. README ─────────────────────────────────────────────────────────
    // The snapshot store exposes a `workspaceRoot` field at runtime but
    // it's not part of the published interface. Read it loosely; fall
    // back to "workspace" if absent so the README still renders.
    const workspaceRoot = ((snapshotStore as unknown as Record<string, unknown>).workspaceRoot ?? 'workspace') as string;
    const repoName = path.basename(workspaceRoot);
    const readmeBody = renderReadme({
        repoName,
        token: options.token,
        fileCount: Object.keys(snapshot.files ?? {}).length,
        apiCount: Object.keys(snapshot.apiIndex ?? {}).length,
        clusterCount: Object.keys(snapshot.clusters ?? {}).length,
    });
    write('README.md', readmeBody);

    log(`[export] wrote ${written.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB to ${outDir}`);
    return { outDir, fileCount: written.length, totalBytes, paths: written };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * JSON.stringify replacer that turns Map / Set instances into plain
 * objects / arrays. The snapshot type uses Maps in a few places
 * (lazy graph map, lookup tables) and JSON.stringify would otherwise
 * silently emit `{}` for them.
 */
function replaceMaps(_key: string, value: unknown): unknown {
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (value instanceof Set) return [...value];
    return value;
}

function copyDirectoryInto(srcDir: string, destDir: string, onFile: (rel: string, bytes: number) => void): void {
    const stack: Array<{ rel: string }> = [{ rel: '' }];
    while (stack.length > 0) {
        const { rel } = stack.pop()!;
        const absSrc = path.join(srcDir, rel);
        const entries = fs.readdirSync(absSrc, { withFileTypes: true });
        for (const e of entries) {
            const relChild = rel ? path.join(rel, e.name) : e.name;
            const absChildSrc = path.join(absSrc, e.name);
            const absChildDest = path.join(destDir, relChild);
            if (e.isDirectory()) {
                fs.mkdirSync(absChildDest, { recursive: true });
                stack.push({ rel: relChild });
            } else if (e.isFile()) {
                fs.mkdirSync(path.dirname(absChildDest), { recursive: true });
                fs.copyFileSync(absChildSrc, absChildDest);
                const size = fs.statSync(absChildSrc).size;
                onFile(relChild, size);
            }
        }
    }
}

function injectTokenGate(html: string, token: string): string {
    const safeToken = JSON.stringify(token);
    const script = `<script>
(function () {
    var key = 'codeatlas-export-token';
    var stored = '';
    try { stored = window.localStorage.getItem(key) || ''; } catch (e) {}
    if (stored !== ${safeToken}) {
        var entered = window.prompt('Enter the sharing token to view this CodeAtlas export:');
        if (entered !== ${safeToken}) {
            document.documentElement.innerHTML = '<body style="font-family:sans-serif;padding:40px;background:#1e1e2e;color:#cdd6f4"><h1>CodeAtlas — gated export</h1><p>This export requires a sharing token. Refresh and enter it to view.</p></body>';
            return;
        }
        try { window.localStorage.setItem(key, entered); } catch (e) {}
    }
})();
</script>`;
    // Inject right after the opening <head> tag if present; fall back to
    // prepending so the gate still fires.
    if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, (m) => `${m}\n${script}\n`);
    }
    return `${script}\n${html}`;
}

function renderReadme(opts: { repoName: string; token?: string; fileCount: number; apiCount: number; clusterCount: number }): string {
    const tokenNote = opts.token
        ? `\n## Sharing token\n\nThis export is token-gated. Recipients need the token below to view it.\n\nFor sharing convenience, set the token via the prompt that appears on first load — it's saved to \`localStorage\` so subsequent visits skip the prompt.\n\nToken: \`${opts.token}\`\n`
        : '';
    return `# CodeAtlas — frozen architecture export\n\n` +
        `Repository: **${opts.repoName}**\n\n` +
        `Stats at export time:\n` +
        `- ${opts.fileCount} files indexed\n` +
        `- ${opts.apiCount} entry points (HTTP / screens / jobs / …)\n` +
        `- ${opts.clusterCount} feature clusters\n\n` +
        `## How to view\n\n` +
        `Open \`index.html\` in any modern browser. The dashboard runs entirely client-side off the bundled \`state.json\` + \`findings.json\` — no server required.\n\n` +
        `To share via static hosting (S3 / GitHub Pages / nginx), upload the directory contents as-is and link to \`index.html\`.\n` +
        tokenNote +
        `\n## Files\n\n` +
        `- \`index.html\`, \`assets/\` — the read-only webview UI.\n` +
        `- \`state.json\` — the full workspace snapshot at export time.\n` +
        `- \`findings.json\` — AI Review findings, if any were captured.\n\n` +
        `## What's missing vs the live extension\n\n` +
        `This export is read-only. The following live behaviors are not part of the bundle:\n\n` +
        `- File watching + cascade refresh — the snapshot is frozen at export time.\n` +
        `- AI Review — the bundled findings are static; you can't trigger a new review here.\n` +
        `- Comments + saved views editing — the bundle preserves what was there at export but new edits don't persist.\n` +
        `- Source-file open-in-editor links — there is no host editor.\n\n` +
        `For the full experience install \`@codeatlas/mcp\` (or the VS Code extension) and point it at the original repository.\n`;
}
