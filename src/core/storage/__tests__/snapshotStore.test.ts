/**
 * snapshotStore.test.ts
 *
 * Covers pruneStaleGraphs() (in-memory only — no I/O), legacy state.json
 * import on first load, and secret redaction inside the `content` field of
 * persisted FileRecords. Persistence assertions read from the SQLite DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../snapshotStore';

function mkWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-snapshot-'));
}

function rmrf(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ─── pruneStaleGraphs (in-memory only — no I/O needed) ───────────────────

describe('pruneStaleGraphs', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    beforeEach(() => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
    });

    afterEach(() => { rmrf(workspaceRoot); });

    it('removes graph whose source file no longer exists', () => {
        const working = store.getWorking();
        working.files['src/app.ts'] = { path: 'src/app.ts', hash: 'h1', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        working.graphs['file:src/app.ts'] = { graphId: 'file:src/app.ts', type: 'file', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['file:src/deleted.ts'] = { graphId: 'file:src/deleted.ts', type: 'file', nodes: [], edges: [], anchors: {} } as any;
        const removed = store.pruneStaleGraphs();
        expect(removed).toBe(1);
        expect(working.graphs['file:src/app.ts']).toBeDefined();
        expect(working.graphs['file:src/deleted.ts']).toBeUndefined();
    });

    it('preserves ghost graphs (nodes with diff:deleted)', () => {
        const working = store.getWorking();
        working.graphs['file:src/ghost.ts'] = {
            graphId: 'file:src/ghost.ts', type: 'file',
            nodes: [{ id: 'n1', diff: 'deleted' }], edges: [], anchors: {},
        } as any;
        expect(store.pruneStaleGraphs()).toBe(0);
        expect(working.graphs['file:src/ghost.ts']).toBeDefined();
    });

    it('handles flow: and sequence: graph ID formats', () => {
        const working = store.getWorking();
        working.files['src/app.ts'] = { path: 'src/app.ts', hash: 'h1', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        working.graphs['flow:src/app.ts:handler'] = { graphId: 'flow:src/app.ts:handler', type: 'flow', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['sequence:src/app.ts:handler'] = { graphId: 'sequence:src/app.ts:handler', type: 'sequence', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['flow:src/old.ts:fn'] = { graphId: 'flow:src/old.ts:fn', type: 'flow', nodes: [], edges: [], anchors: {} } as any;
        expect(store.pruneStaleGraphs()).toBe(1);
        expect(working.graphs['flow:src/app.ts:handler']).toBeDefined();
        expect(working.graphs['sequence:src/app.ts:handler']).toBeDefined();
        expect(working.graphs['flow:src/old.ts:fn']).toBeUndefined();
    });

    it('returns 0 when no orphaned graphs exist', () => {
        const working = store.getWorking();
        working.files['a.ts'] = { path: 'a.ts', hash: 'h1', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        working.graphs['file:a.ts'] = { graphId: 'file:a.ts', type: 'file', nodes: [], edges: [], anchors: {} } as any;
        expect(store.pruneStaleGraphs()).toBe(0);
    });

    it('returns 0 on empty state', () => {
        expect(store.pruneStaleGraphs()).toBe(0);
    });

    it('does NOT prune sequence graphs with colons in handler name (anonymous@GET:/route)', () => {
        const working = store.getWorking();
        working.files['src/controller.ts'] = { path: 'src/controller.ts', hash: 'h1', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        working.graphs['sequence:src/controller.ts:anonymous@GET:/api/articles'] = {
            graphId: 'sequence:src/controller.ts:anonymous@GET:/api/articles',
            type: 'sequence', nodes: [], edges: [], anchors: {},
        } as any;
        working.graphs['sequence:src/controller.ts:anonymous@POST:/api/articles'] = {
            graphId: 'sequence:src/controller.ts:anonymous@POST:/api/articles',
            type: 'sequence', nodes: [], edges: [], anchors: {},
        } as any;
        expect(store.pruneStaleGraphs()).toBe(0);
        expect(working.graphs['sequence:src/controller.ts:anonymous@GET:/api/articles']).toBeDefined();
        expect(working.graphs['sequence:src/controller.ts:anonymous@POST:/api/articles']).toBeDefined();
    });

    it('#906 — keeps a synthetic sequence graph backed by a live IaC API (filePath not a FileRecord)', () => {
        const working = store.getWorking();
        // An IaC route: filePath is a manifest (serverless.yml), NOT a parsed
        // source file, so it's absent from `files` / liveFiles.
        working.apiIndex['POST:/deploy'] = {
            apiId: 'POST:/deploy', method: 'POST', route: '/deploy',
            filePath: 'serverless.yml', handlerName: 'deploy',
        } as any;
        // A real source file exists (so the snapshot isn't empty).
        working.files['src/app.ts'] = { path: 'src/app.ts', hash: 'h1', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        // The synthetic sequence graph for the IaC route — would be pruned as an
        // orphan (serverless.yml ∉ liveFiles) without #906.
        working.graphs['sequence:serverless.yml:deploy'] = {
            graphId: 'sequence:serverless.yml:deploy', type: 'sequence',
            nodes: [{ id: 'p1' }], edges: [], anchors: {},
        } as any;
        // A genuinely-stale sequence graph: no FileRecord AND no backing API.
        working.graphs['sequence:gone.ts:dead'] = {
            graphId: 'sequence:gone.ts:dead', type: 'sequence',
            nodes: [{ id: 'p1' }], edges: [], anchors: {},
        } as any;
        const removed = store.pruneStaleGraphs();
        expect(removed).toBe(1); // only the truly-stale one
        expect(working.graphs['sequence:serverless.yml:deploy'], 'IaC sequence must survive (no ghost diff)').toBeDefined();
        expect(working.graphs['sequence:gone.ts:dead'], 'truly-stale sequence still pruned').toBeUndefined();
    });

    it('skips non-file-scoped graph IDs (microservice/feature/api-list/health)', () => {
        const working = store.getWorking();
        working.graphs['microservice:workspace'] = { graphId: 'microservice:workspace', type: 'microservice', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['feature:workspace'] = { graphId: 'feature:workspace', type: 'feature', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['api-list:cluster:auth'] = { graphId: 'api-list:cluster:auth', type: 'api-list', nodes: [], edges: [], anchors: {} } as any;
        working.graphs['health:report'] = { graphId: 'health:report', type: 'health', nodes: [], edges: [], anchors: {} } as any;
        expect(store.pruneStaleGraphs()).toBe(0);
    });
});

// ─── legacy state.json import (the only fallback path that still parses JSON) ──

describe('load() — legacy state.json import', () => {
    let workspaceRoot: string;

    beforeEach(() => { workspaceRoot = mkWorkspace(); });
    afterEach(() => { rmrf(workspaceRoot); });

    function writeLegacy(content: string): void {
        const dir = path.join(workspaceRoot, '.codeatlas');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), content);
    }

    it('imports a valid legacy state.json into the SQLite DB on first load', async () => {
        const valid = {
            baseline: { files: { 'a.ts': { path: 'a.ts' } }, apiIndex: {}, graphs: {} },
            working: { files: { 'b.ts': { path: 'b.ts' } }, apiIndex: {}, graphs: {} },
            comments: [],
        };
        writeLegacy(JSON.stringify(valid));
        const store = new SnapshotStore(workspaceRoot);
        const state = await store.load();
        expect(Object.keys(state.baseline.files)).toContain('a.ts');
        expect(Object.keys(state.working.files)).toContain('b.ts');
    });

    it('falls back to empty state when legacy state.json is invalid JSON', async () => {
        writeLegacy('{not json!!');
        const store = new SnapshotStore(workspaceRoot);
        const state = await store.load();
        expect(state.baseline.files).toEqual({});
        expect(state.working.files).toEqual({});
    });

    it('falls back to empty state when legacy state.json is an array', async () => {
        writeLegacy('[]');
        const store = new SnapshotStore(workspaceRoot);
        const state = await store.load();
        expect(state.baseline).toBeDefined();
        expect(state.working).toBeDefined();
    });

    it('falls back to empty state when legacy state.json is missing baseline.apiIndex', async () => {
        writeLegacy(JSON.stringify({
            baseline: { files: {} }, // missing apiIndex and graphs
            working: { files: {}, apiIndex: {}, graphs: {} },
        }));
        const store = new SnapshotStore(workspaceRoot);
        const state = await store.load();
        expect(state.baseline.apiIndex).toEqual({});
        expect(state.baseline.graphs).toEqual({});
    });

    it('returns empty state when no legacy file and no DB exist', async () => {
        const store = new SnapshotStore(workspaceRoot);
        const state = await store.load();
        expect(state.baseline.files).toEqual({});
        expect(state.working.files).toEqual({});
    });

    it('does NOT re-import legacy file once SQLite already has data', async () => {
        const initial = {
            baseline: { files: { 'first.ts': { path: 'first.ts' } }, apiIndex: {}, graphs: {} },
            working: { files: { 'first.ts': { path: 'first.ts' } }, apiIndex: {}, graphs: {} },
        };
        writeLegacy(JSON.stringify(initial));
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.save();
        // Mutate legacy file to look completely different.
        writeLegacy(JSON.stringify({
            baseline: { files: { 'second.ts': {} }, apiIndex: {}, graphs: {} },
            working: { files: { 'second.ts': {} }, apiIndex: {}, graphs: {} },
        }));
        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        // SQLite wins; legacy is ignored once data exists.
        expect(Object.keys(state.baseline.files)).toContain('first.ts');
        expect(Object.keys(state.baseline.files)).not.toContain('second.ts');
    });
});

// ─── secret redaction in save() — assert on stored DB rows ───────────────

describe('secret redaction in save()', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    beforeEach(async () => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
        await store.load();
    });

    afterEach(() => { rmrf(workspaceRoot); });

    function fileRowJson(snapshotKind: 'baseline' | 'working', filePath: string): string {
        // Read both columns: content lives in its own column post-#354 memory fix,
        // metadata stays in record_json. Concatenate for substring assertions.
        const sqlite = store.getSqliteStore();
        const row = sqlite.get(
            `SELECT record_json, content FROM files WHERE snapshot_kind = ? AND path = ?`,
            [snapshotKind, filePath],
        );
        if (!row) return '';
        return String(row.record_json) + '\n' + (row.content == null ? '' : String(row.content));
    }

    it('redacts PASSWORD values in the persisted content column', () => {
        store.getWorking().files['config.ts'] = {
            path: 'config.ts', hash: 'h1', mtime: 0,
            content: 'const PASSWORD = "super_secret_123";\nconst name = "app";',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'config.ts');
        expect(raw).toContain('[REDACTED]');
        expect(raw).not.toContain('super_secret_123');
    });

    // #11059 — the redactor matched the keyword `token` inside `refresh_token`
    // and blanked the VALUE `"refresh_token"` to `[REDACTED]`, destroying a real
    // bug (`...refresh_token = "refresh_token"` reads as deliberate redaction, so
    // no reviewer can flag the hardcoded-placeholder defect). A value that is
    // itself a known field/placeholder literal is never a credential — keep it.
    it('#11059 — does NOT redact a value that is a known field-name literal (refresh_token = "refresh_token")', () => {
        store.getWorking().files['oauth.ts'] = {
            path: 'oauth.ts', hash: 'h3', mtime: 0,
            content: 'if (!data.refresh_token) {\n  data.refresh_token = "refresh_token";\n}\nconst token = "aB3xK9pQ2mZ7wL1nR5vT";',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'oauth.ts');
        // the placeholder literal survives so the hardcoded-string bug stays visible…
        expect(raw).toContain('"refresh_token"');
        // …but a genuine high-entropy secret on the same file is still redacted.
        expect(raw).toContain('[REDACTED]');
        expect(raw).not.toContain('aB3xK9pQ2mZ7wL1nR5vT');
    });

    it('redacts connection URIs (mongodb://, postgres://)', () => {
        store.getWorking().files['db.ts'] = {
            path: 'db.ts', hash: 'h2', mtime: 0,
            content: 'const uri = "mongodb://admin:pass@host:27017/db";\nconst pg = "postgres://user:pwd@localhost/mydb";',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'db.ts');
        expect(raw).toContain('[REDACTED_URI]');
        expect(raw).not.toContain('admin:pass');
        expect(raw).not.toContain('user:pwd');
    });

    /**
     * #448-A-infra-edge: the URL-with-credentials redactor was line-greedy —
     * `/https?:\/\/[^:]+:[^@]+@/gi` would match from a doc-comment URL across
     * 20+ lines down to a format string containing `@`, collapsing imports
     * and infrastructure-detection signals (like `"database/sql"`). Cascade
     * rebuilds then read this redacted content from disk and missed the
     * `database/sql` pattern, dropping the mysql→SQL(Go) infra edge from L1.
     */
    it('URL-with-credentials redactor does NOT span newlines (#448-A-infra-edge)', () => {
        // Real-world go-fiber/mysql/main.go shape: doc URLs in comments,
        // imports, then a format string later containing `@`.
        const source = `// https://docs.gofiber.io
// https://github.com/gofiber/fiber
package main
import (
\t"database/sql"
)
func main() {
\tdb := sql.Open("mysql", fmt.Sprintf("%s:%s@/%s", user, password, name))
}`;
        store.getWorking().files['mysql.go'] = {
            path: 'mysql.go', hash: 'h_mysql', mtime: 0,
            content: source,
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'mysql.go');
        // Real credential-URL like https://user:pass@host SHOULD redact —
        // but plain URLs in comments must NOT collapse across newlines.
        expect(raw, 'database/sql import must survive redaction').toContain('database/sql');
        expect(raw, 'package declaration must survive').toContain('package main');
    });

    it('does NOT redact normal code', () => {
        store.getWorking().files['app.ts'] = {
            path: 'app.ts', hash: 'h3', mtime: 0,
            content: 'function hello() { return "world"; }',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'app.ts');
        expect(raw).toContain('function hello()');
        expect(raw).not.toContain('[REDACTED]');
    });

    it('redacts API_KEY and TOKEN patterns', () => {
        store.getWorking().files['env.ts'] = {
            path: 'env.ts', hash: 'h4', mtime: 0,
            content: 'const API_KEY = "sk-abc123def456";\nconst AUTH_TOKEN = "bearer_xyz789";\nconst VERSION = "1.0";',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'env.ts');
        expect(raw).not.toContain('sk-abc123def456');
        expect(raw).not.toContain('bearer_xyz789');
        expect(raw).toContain('VERSION');
    });

    it('redacts unquoted secret values (env file style)', () => {
        store.getWorking().files['env.txt'] = {
            path: 'env.txt', hash: 'h6', mtime: 0,
            content: 'PASSWORD=my_super_secret_password\nDB_HOST=localhost',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'env.txt');
        expect(raw).not.toContain('my_super_secret_password');
        expect(raw).toContain('[REDACTED]');
        expect(raw).toContain('DB_HOST');
    });

    it('preserves short values (< {8,} threshold) — not considered secrets', () => {
        store.getWorking().files['short.ts'] = {
            path: 'short.ts', hash: 'h5', mtime: 0,
            content: 'const TOKEN = "ab";',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'short.ts');
        expect(raw).not.toContain('[REDACTED]');
        expect(raw).toContain('ab');
    });

    it('#908 — a >256KB file with many secret assignments redacts line-by-line under a bound', () => {
        // Build a large (~1MB) file: thousands of `PASSWORD=…` lines (each a real
        // secret assignment) PLUS one pathological minified mega-line that would
        // make the value regexes backtrack catastrophically on the whole content.
        const secretLine = 'PASSWORD=super_secret_value_abc12345\n';
        const body = secretLine.repeat(28_000); // ~1MB, well over the 256KB whole-content threshold
        const megaLine = 'x'.repeat(300_000) + '\n'; // a single minified line > the per-line cap
        const content = body + megaLine + 'API_KEY=another_secret_key_xyz98765\n';
        store.getWorking().files['big.env'] = {
            path: 'big.env', hash: 'h_big', mtime: 0,
            content,
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        const t0 = Date.now();
        store.save();
        const elapsed = Date.now() - t0;
        const raw = fileRowJson('working', 'big.env');
        // Secrets on normal-length lines ARE redacted even in a large file.
        expect(raw).toContain('[REDACTED]');
        expect(raw).not.toContain('super_secret_value_abc12345');
        expect(raw).not.toContain('another_secret_key_xyz98765');
        // The save (incl. redaction) completes well under a generous bound — the
        // old whole-content regex on the 300KB minified line would backtrack/hang.
        expect(elapsed, `save took ${elapsed}ms`).toBeLessThan(3000);
    });

    // Issue 377: when a JS/TS object literal has `password: hashedPassword` (or
    // any of the protected key names followed by `:` + identifier value), the
    // redactor used to rewrite the entire pair as `password= [REDACTED]` —
    // changing the `:` separator into `=` and leaving the value unquoted. The
    // result is invalid JS that Babel cannot parse, which cascaded into:
    //   - L4 file-graph showing every node `unchanged` (buildEntityDiff's
    //     try/catch swallowed the parse error and returned empty diffs)
    //   - L3 sequence over-marking edges that pass through createUser /
    //     updateUser etc., because srcText slices of the corrupted baseline
    //     differed from working raw text
    //   - L2b reporting 3 modified APIs instead of 1
    //   - L1 bottom strip surfacing the wrong function name as the change.
    // The post-fix redactor preserves the original separator and quotes the
    // value so the output stays valid JS.
    it('produces VALID JS syntax when redacting object literal properties (#377)', () => {
        const { parse } = require('@babel/parser');
        const source = `
const user = await prisma.user.create({
  data: {
    username,
    email,
    password: hashedPassword,
  },
});
`;
        store.getWorking().files['auth.service.ts'] = {
            path: 'auth.service.ts', hash: 'h7', mtime: 0,
            content: source,
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'auth.service.ts');
        // Redacted form must keep the colon separator and quote the value
        expect(raw).toContain('password: "[REDACTED]"');
        expect(raw).not.toContain('password= [REDACTED]');
        expect(raw).not.toContain('hashedPassword');

        // And the persisted content must parse cleanly — this is the core
        // guarantee that downstream consumers (buildEntityDiff,
        // buildSequenceDiff, etc.) depend on. Pre-fix this throws.
        const persistedContent = store.getFileContent('working', 'auth.service.ts')!;
        expect(() => parse(persistedContent, { sourceType: 'module', plugins: ['typescript'] }))
            .not.toThrow();
    });

    // Issue 377 companion: env-style `PASSWORD=abc123xyz` keeps the `=` separator
    // (still valid syntax in env loaders / shell scripts) and quotes the value.
    it('preserves `=` separator and quotes value for env-style assignments (#377)', () => {
        store.getWorking().files['legacy.env.ts'] = {
            path: 'legacy.env.ts', hash: 'h8', mtime: 0,
            content: 'const PASSWORD = supersecretvalue;\nconst API_KEY = anothersecret123;',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        store.save();
        const raw = fileRowJson('working', 'legacy.env.ts');
        expect(raw).toContain('PASSWORD = "[REDACTED]"');
        expect(raw).toContain('API_KEY = "[REDACTED]"');
        expect(raw).not.toContain('supersecretvalue');
        expect(raw).not.toContain('anothersecret123');
    });
});

describe('#936 — setBaselineFileContent backfills baseline content', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;
    beforeEach(async () => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
        await store.load();
        // save() persists BOTH snapshot kinds, creating the `baseline` snapshots row
        // that the `files.snapshot_kind` FK requires (the review-pr flow's init does
        // this before the backfill runs).
        store.save();
    });
    afterEach(() => { rmrf(workspaceRoot); });

    it('inserts a baseline row for a path that had none, retrievable via getFileContent', () => {
        // Style files are never parsed at init, so no baseline row exists.
        expect(store.getFileContent('baseline', 'app/styles/header.scss')).toBeUndefined();
        store.setBaselineFileContent('app/styles/header.scss', 'a { color: scale-color($p, 30%); }');
        expect(store.getFileContent('baseline', 'app/styles/header.scss')).toBe('a { color: scale-color($p, 30%); }');
        // Working remains untouched (the backfill is baseline-only).
        expect(store.getFileContent('working', 'app/styles/header.scss')).toBeUndefined();
    });

    it('ON CONFLICT updates content for an existing baseline row', () => {
        store.setBaselineFileContent('x.scss', 'old');
        store.setBaselineFileContent('x.scss', 'new-content');
        expect(store.getFileContent('baseline', 'x.scss')).toBe('new-content');
    });

    it('writes the in-memory baseline record even when NOT initialized (review-pr store) — #936 regression', () => {
        // The review-pr pipeline store is not `initialized`, so getFileContent is a no-op
        // and the diff window relies on getBaseline().files[fp].content. The in-memory write
        // MUST happen regardless of `initialized` (the first version no-op'd the whole method).
        const s = new SnapshotStore(mkWorkspace()); // NO load() → initialized === false
        s.setBaselineFileContent('app/x.scss', 'a { color: blue; }');
        expect((s.getBaseline().files as Record<string, { content?: string }>)['app/x.scss']?.content).toBe('a { color: blue; }');
    });

    it('survives a subsequent save() — NOT tombstoned by persistSnapshot (#936 regression)', () => {
        // The review-pr cascade calls save() AFTER the backfill; persistSnapshot('baseline')
        // deletes baseline rows absent from state.baseline.files, so a SQLite-only write would
        // be wiped and the diff would relapse to all-`+` NEW FILE.
        store.setBaselineFileContent('app/styles/header.scss', 'a { color: red; }');
        store.save();
        expect(store.getFileContent('baseline', 'app/styles/header.scss')).toBe('a { color: red; }');
    });

    it('redacts secrets in the backfilled content', () => {
        store.setBaselineFileContent('cfg.scss', 'API_KEY = "sk-realbackfillsecretvalue123";');
        const c = store.getFileContent('baseline', 'cfg.scss')!;
        expect(c).toContain('[REDACTED]');
        expect(c).not.toContain('sk-realbackfillsecretvalue123');
    });
});

// ─── round-trip: save → re-open → load → state matches ──────────────────

describe('save / load round-trip', () => {
    let workspaceRoot: string;

    beforeEach(() => { workspaceRoot = mkWorkspace(); });
    afterEach(() => { rmrf(workspaceRoot); });

    it('preserves baseline + working files across re-open', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.getWorking().files['x.ts'] = { path: 'x.ts', hash: 'h', mtime: 0, content: 'ok', symbols: { functions: [], variables: [], imports: [] } } as any;
        s1.setBaselineFromWorking();
        s1.save();
        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(Object.keys(state.working.files)).toContain('x.ts');
        expect(Object.keys(state.baseline.files)).toContain('x.ts');
    });

    it('#909 — setBaselineFromWorking after forgetContentInMemory still gives baseline content', async () => {
        const s = new SnapshotStore(workspaceRoot);
        await s.load();
        s.getWorking().files['svc.ts'] = {
            path: 'svc.ts', hash: 'h', mtime: 0,
            content: 'export function svc() { return 42; }',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        // First save persists working content to SQLite AND drops it from RAM
        // (lazy-content). After this, working.files['svc.ts'].content is gone.
        s.save();
        s.forgetContentInMemory(); // belt-and-suspenders: force the post-forget state
        expect((s.getWorking().files['svc.ts'] as any).content).toBeUndefined();

        // Rotate baseline POST-forget. The old code cloned the (now-empty)
        // in-memory `.content` → baseline content NULL. The SQL copy pulls the
        // persisted (redacted) working content column instead.
        s.setBaselineFromWorking();
        const baselineContent = s.getFileContent('baseline', 'svc.ts');
        expect(baselineContent, 'baseline content must survive a post-forget rotation').toBeDefined();
        expect(baselineContent).toContain('function svc()');
    });

    it('clearAllFiles() empties the DB and survives re-open', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.getWorking().files['a.ts'] = { path: 'a.ts', hash: 'h', mtime: 0, content: 'x', symbols: { functions: [], variables: [], imports: [] } } as any;
        s1.save();
        s1.clearAllFiles();
        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.files).toEqual({});
        expect(state.baseline.files).toEqual({});
    });

    it('clearAllFiles() removes the legacy state.json so it cannot re-seed the DB', async () => {
        const dir = path.join(workspaceRoot, '.codeatlas');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            baseline: { files: { 'old.ts': {} }, apiIndex: {}, graphs: {} },
            working: { files: { 'old.ts': {} }, apiIndex: {}, graphs: {} },
        }));
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.clearAllFiles();
        expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
    });

    it('clearAllFiles() removes ALL legacy files (state.json + git-diff + llm-names + change-log)', async () => {
        const dir = path.join(workspaceRoot, '.codeatlas');
        fs.mkdirSync(dir, { recursive: true });
        const legacyFiles = ['state.json', 'git-diff-state.json', 'llm-names.json', 'change-log.json'];
        for (const name of legacyFiles) {
            fs.writeFileSync(path.join(dir, name), '{}');
        }
        const s = new SnapshotStore(workspaceRoot);
        await s.load();
        s.clearAllFiles();
        for (const name of legacyFiles) {
            expect(fs.existsSync(path.join(dir, name)), `${name} should be removed`).toBe(false);
        }
    });

    // v2 phase 2 PR-A back-compat — pre-#482 snapshots wrote
    // ServiceRecord rows without a `category` field. Loading them must
    // default to `'backend'` so the FE/mobile-only L1 enrichment doesn't
    // accidentally fire on legacy data. Without this guard, an old
    // 6.1.0 .codeatlas/state.db opened in 6.1.1+ would have services
    // with `category === undefined`, and any `category === 'frontend'`
    // check would (correctly) skip SDK detection — BUT downstream
    // diff comparisons could trip on the missing field.
    it('legacy snapshot without ServiceRecord.category loads with category=backend', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        // Round-trip a real service through save() so the snapshot kind
        // row exists (foreign-key constraint), then rewrite that row's
        // service_json to mimic the pre-#482 shape (no category field).
        s1.updateWorkingServices({
            'service:legacy': {
                id: 'service:legacy', name: 'legacy', rootPath: 'apps/legacy',
                technology: 'express', category: 'backend',
                exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                diff: 'unchanged',
            },
        });
        s1.save();
        // Strip the category field from the persisted JSON to simulate
        // a 6.1.0-era row.
        const legacyJson = JSON.stringify({
            id: 'service:legacy', name: 'legacy', rootPath: 'apps/legacy',
            technology: 'express', exposedApiCount: 0, consumedUrls: [],
            consumedServices: [], diff: 'unchanged',
        });
        (s1 as any).sqlite.run(
            'UPDATE services SET service_json = ? WHERE snapshot_kind = ? AND service_id = ?',
            [legacyJson, 'working', 'service:legacy'],
        );

        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        const loaded = state.working.services?.['service:legacy'];
        expect(loaded).toBeDefined();
        expect(loaded!.category).toBe('backend');
        expect(loaded!.technology).toBe('express');
    });

    // Issue #701 / #734 — domains round-trip storage test.
    // Locks the contract: `updateWorkingDomains` writes persist to the
    // sqlite v9 `domains` table, re-load into `snapshot.domains`, and
    // `setBaselineFromWorking` clones forward so the next cascade can
    // diff added/removed/modified domains.
    it('domains round-trip: write working domains, reload, baseline gets them via setBaselineFromWorking', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        const domain = {
            id: 'domain:authenticate-users',
            name: 'Authenticate users',
            verb: 'authenticate',
            routes: ['GET:/login::src/auth.ts::loginHandler'],
            files: ['src/auth.ts'],
            confidence: 0.7,
            source: 'llm-refined' as const,
        };
        s1.updateWorkingDomains({ [domain.id]: domain });
        s1.setBaselineFromWorking();
        s1.save();

        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.domains?.[domain.id]).toBeDefined();
        expect(state.working.domains?.[domain.id].name).toBe('Authenticate users');
        expect(state.working.domains?.[domain.id].source).toBe('llm-refined');
        // setBaselineFromWorking should clone domains to baseline.
        expect(state.baseline.domains?.[domain.id]).toBeDefined();
        expect(state.baseline.domains?.[domain.id].verb).toBe('authenticate');
    });

    // v2 phase 3 PR-A — screens round-trip storage test.
    // Locks the contract: `updateWorkingScreens` writes are persisted,
    // re-loaded into `snapshot.screens`, and `setBaselineFromWorking`
    // copies them forward to baseline so the next cascade can diff
    // added/removed/modified screens between baseline and working.
    it('screens round-trip: write working screens, reload, baseline gets them via setBaselineFromWorking', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        const screen = {
            screenId: 'screen:service:web:/dashboard',
            serviceId: 'service:web',
            routePath: '/dashboard',
            framework: 'nextjs-app' as const,
            filePath: 'apps/web/app/dashboard/page.tsx',
            anchor: { filePath: 'apps/web/app/dashboard/page.tsx', lineStart: 1, lineEnd: 1 },
            diff: 'unchanged' as const,
        };
        s1.updateWorkingScreens({ [screen.screenId]: screen });
        s1.setBaselineFromWorking();
        s1.save();

        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.screens?.[screen.screenId]).toBeDefined();
        expect(state.working.screens?.[screen.screenId].routePath).toBe('/dashboard');
        // setBaselineFromWorking should clone screens to baseline.
        expect(state.baseline.screens?.[screen.screenId]).toBeDefined();
        expect(state.baseline.screens?.[screen.screenId].routePath).toBe('/dashboard');
    });

    // v2 phase 4 PR-A — screen_items round-trip storage test.
    // Locks the contract: `updateWorkingScreenItems` writes are
    // persisted, re-loaded into `snapshot.screenItems`, and
    // `setBaselineFromWorking` copies them forward so PR-B+ detectors
    // get a working baseline to diff against.
    it('screen_items round-trip: write, reload, baseline gets them via setBaselineFromWorking', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        const item = {
            itemId: 'interactions:apps/web/Login.tsx:onSubmit',
            screenId: 'screen:service:web:/login',
            section: 'interactions' as const,
            kind: 'interaction:submit',
            label: 'onSubmit',
            handlerName: 'handleSubmit',
            filePath: 'apps/web/Login.tsx',
            anchor: { filePath: 'apps/web/Login.tsx', lineStart: 12, lineEnd: 18 },
            diff: 'unchanged' as const,
        };
        s1.updateWorkingScreenItems({
            'screen:service:web:/login': [item],
        });
        s1.setBaselineFromWorking();
        s1.save();

        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        const items = state.working.screenItems?.['screen:service:web:/login'];
        expect(items).toBeDefined();
        expect(items!.length).toBe(1);
        expect(items![0].section).toBe('interactions');
        expect(items![0].handlerName).toBe('handleSubmit');
        // setBaselineFromWorking should clone screenItems forward.
        expect(state.baseline.screenItems?.['screen:service:web:/login']).toBeDefined();
    });

    // Pre-v8 snapshots (created on phase-3 builds or earlier) have no
    // `screen_items` table — the schema migration creates it empty.
    // Loading must produce `screenItems: undefined` so PR-B+ detectors
    // can distinguish "this snapshot was never extracted" from
    // "extraction ran and found zero items".
    it('pre-v8 snapshot with no screen_items table loads with screenItems=undefined', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        // Populate something else; skip screen_items entirely.
        s1.updateWorkingServices({
            'service:api': {
                id: 'service:api', name: 'api', rootPath: 'apps/api',
                technology: 'express', category: 'backend',
                exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                diff: 'unchanged',
            },
        });
        s1.save();
        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.screenItems).toBeUndefined();
    });

    // Pre-v7 snapshots (created on 6.1.x or earlier) have no `screens`
    // table — the schema migration in v7 creates it empty. Loading must
    // produce undefined `snapshot.screens` (NOT crash, NOT default to
    // `{}`) so downstream callers can distinguish "no screens yet"
    // from "this service detected zero screens".
    it('pre-v7 snapshot with no screens table loads with screens=undefined', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        // Populate working but skip screens entirely.
        s1.updateWorkingServices({
            'service:api': {
                id: 'service:api', name: 'api', rootPath: 'apps/api',
                technology: 'express', category: 'backend',
                exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                diff: 'unchanged',
            },
        });
        s1.save();
        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.screens).toBeUndefined();
    });

    // Modern snapshots that already carry a category survive the
    // round-trip unchanged — the load-time default must NOT clobber a
    // real value.
    it('modern snapshot with ServiceRecord.category=frontend round-trips unchanged', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.updateWorkingServices({
            'service:web': {
                id: 'service:web', name: 'web', rootPath: 'apps/web',
                technology: 'nextjs', category: 'frontend',
                exposedApiCount: 5, consumedUrls: [], consumedServices: [],
                diff: 'unchanged',
            },
        });
        s1.save();

        const s2 = new SnapshotStore(workspaceRoot);
        const state = await s2.load();
        expect(state.working.services?.['service:web']?.category).toBe('frontend');
    });

    it('lazy content: hydrate strips content; getFileContent fetches from DB on demand', async () => {
        const s1 = new SnapshotStore(workspaceRoot);
        await s1.load();
        s1.getWorking().files['x.ts'] = {
            path: 'x.ts', hash: 'h', mtime: 0,
            content: 'const a = 1;',
            symbols: { functions: [], variables: [], imports: [] },
        } as any;
        s1.save();
        // Post-save: content was dropped from in-memory FileRecord.
        expect((s1.getWorking().files['x.ts'] as any).content).toBeUndefined();
        // But getFileContent fetches it lazily from the DB.
        expect(s1.getFileContent('working', 'x.ts')).toBe('const a = 1;');

        // Re-open in a fresh instance — hydrate must not bring content back.
        const s2 = new SnapshotStore(workspaceRoot);
        await s2.load();
        expect((s2.getWorking().files['x.ts'] as any).content).toBeUndefined();
        expect(s2.getFileContent('working', 'x.ts')).toBe('const a = 1;');
    });

    it('lazy content: getAllFileContents returns the full kind-scoped map', async () => {
        const s = new SnapshotStore(workspaceRoot);
        await s.load();
        s.getWorking().files['a.ts'] = { path: 'a.ts', hash: '1', mtime: 0, content: 'A', symbols: { functions: [], variables: [], imports: [] } } as any;
        s.getWorking().files['b.ts'] = { path: 'b.ts', hash: '2', mtime: 0, content: 'B', symbols: { functions: [], variables: [], imports: [] } } as any;
        s.save();
        const all = s.getAllFileContents('working');
        expect(all.size).toBe(2);
        expect(all.get('a.ts')).toBe('A');
        expect(all.get('b.ts')).toBe('B');
    });

    it('lazy content: setFileContent updates the column without disturbing metadata', async () => {
        const s = new SnapshotStore(workspaceRoot);
        await s.load();
        s.getWorking().files['x.ts'] = { path: 'x.ts', hash: 'h', mtime: 0, content: 'old', symbols: { functions: [], variables: [], imports: [] } } as any;
        s.save();
        s.setFileContent('working', 'x.ts', 'updated source');
        expect(s.getFileContent('working', 'x.ts')).toBe('updated source');
        // Metadata still loadable via fresh instance.
        const s2 = new SnapshotStore(workspaceRoot);
        await s2.load();
        expect(s2.getWorking().files['x.ts']?.hash).toBe('h');
    });

    it('clearAllFiles() leaves every SQLite table empty (cascade verified)', async () => {
        const s = new SnapshotStore(workspaceRoot);
        await s.load();
        // Populate snapshots + comments via the public API.
        s.getWorking().files['a.ts'] = { path: 'a.ts', hash: 'h', mtime: 0, content: '', symbols: { functions: [], variables: [], imports: [] } } as any;
        s.setBaselineFromWorking();
        s.setComments([{ id: 'c1', layer: 'file', targetType: 'node', targetId: 'a', anchor: { filePath: 'a.ts' }, body: 'x', status: 'open', createdAt: Date.now() } as any]);
        s.save();
        // Sanity: rows exist.
        const sqlite = s.getSqliteStore();
        expect(Number(sqlite.get('SELECT COUNT(*) AS n FROM snapshots')?.n)).toBe(2);
        expect(Number(sqlite.get('SELECT COUNT(*) AS n FROM comments')?.n)).toBe(1);
        // Clear and verify every table is empty.
        s.clearAllFiles();
        const tables = [
            'git_refs', 'snapshots', 'files', 'apis', 'graphs', 'clusters',
            'services', 'singletons', 'comments',
            'llm_cluster_names', 'llm_service_descriptions', 'llm_api_annotations',
            'git_diff_sessions', 'change_log', 'settings',
        ];
        for (const t of tables) {
            const n = Number(sqlite.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n);
            expect(n, `table ${t} not empty after clearAllFiles()`).toBe(0);
        }
    });
});

// ─── load() idempotency (Issue 405 — `openSequenceForApi` lookup misses entries even when apiIndex contains them) ─────────────────────────────────────────

describe('load() idempotency — Issue 405', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    beforeEach(() => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
    });

    afterEach(() => { rmrf(workspaceRoot); });

    it('a second load() does NOT wipe an in-memory apiIndex populated by an init that ran between the two loads', async () => {
        // Repro of the live-verification bug: extension.ts:483 fires
        // `loadStateAfterAuth()` (which calls store.load()) while
        // AutoInit's `initialize()` is mid-flight in another branch.
        // initialize() calls clearAllFiles (empties the DB) then
        // repopulates state.working.apiIndex in memory. If the second
        // load() refreshes from the (now-empty) DB DURING init, the
        // in-memory apiIndex gets wiped and stays empty — even though
        // init's later save() puts the data back on disk.
        await store.load();
        // Simulate init: clear, then repopulate apiIndex in memory.
        store.clearAllFiles();
        const apiId = 'GET:/x::src/c.ts::anon@GET:/x';
        store.updateWorkingApi(apiId, {
            apiId, method: 'GET', route: '/x',
            handlerName: 'anon@GET:/x', filePath: 'src/c.ts', kind: 'route',
        } as any);
        expect(Object.keys(store.getWorking().apiIndex)).toEqual([apiId]);

        // A second load() in this window must NOT wipe the in-memory
        // apiIndex. Pre-fix behaviour: load() unconditionally called
        // refresh() which re-read the still-empty DB and clobbered memory.
        await store.load();
        expect(Object.keys(store.getWorking().apiIndex), 'second load() wiped in-memory apiIndex').toEqual([apiId]);
    });

    it('refresh() is still callable explicitly for callers that want DB→memory re-read (mcp-server contract)', async () => {
        await store.load();
        const apiId = 'GET:/y::src/c.ts::anon@GET:/y';
        store.updateWorkingApi(apiId, {
            apiId, method: 'GET', route: '/y',
            handlerName: 'anon@GET:/y', filePath: 'src/c.ts', kind: 'route',
        } as any);
        // The in-memory update is not yet persisted — explicit refresh()
        // discards it (this is the explicit "re-read from DB" contract
        // mcp-server relies on). The contrast vs the test above is what
        // matters: load() is now idempotent; refresh() remains destructive.
        store.refresh();
        expect(Object.keys(store.getWorking().apiIndex)).toEqual([]);
    });

    it('Issue 405 ROOT CAUSE: two concurrent load() calls must NOT both refresh — second wipes apiIndex of the first', async () => {
        // Repro of the real live bug:
        // 1. activate() fires `void loadStateAfterAuth()` (load() #1) before
        //    awaiting `snapshotStore.load()` (load() #2) later in the same
        //    function. Both schedule before init resolves.
        // 2. Both evaluate `if (!this.initialized)` (or whatever guard) BEFORE
        //    `await this.sqlite.init()`. Both pass.
        // 3. After init resolves, BOTH continue past the guard. If `refresh()`
        //    is called twice, the second one re-reads from the (possibly mid-
        //    init-emptied) DB and clobbers the in-memory `apiIndex` that the
        //    first call had populated.
        //
        // Pre-fix behavior: refresh() ran twice. The test simulates by
        // populating apiIndex in memory BETWEEN the two load awaits and
        // asserting the second load() doesn't wipe it.
        const [p1, p2] = [store.load(), store.load()];
        await p1;
        // Simulate init mid-flight by populating apiIndex AFTER the first
        // load resolves but BEFORE the second one.
        const apiId = 'GET:/z::src/c.ts::anon@GET:/z';
        store.updateWorkingApi(apiId, {
            apiId, method: 'GET', route: '/z',
            handlerName: 'anon@GET:/z', filePath: 'src/c.ts', kind: 'route',
        } as any);
        // Both promises must resolve to the same state. Pre-fix, the second
        // resolution ran refresh() which wiped apiIndex.
        await p2;
        expect(Object.keys(store.getWorking().apiIndex), 'concurrent load() #2 wiped apiIndex populated between the awaits').toEqual([apiId]);
    });

    it('concurrent load() calls share a single in-flight promise', async () => {
        // Stronger contract: three concurrent load() promises all resolve
        // to the same state instance. Without single-flight, the second
        // and third calls would each run their own `refresh()` and the
        // returned state could be a different reference per call.
        const [p1, p2, p3] = [store.load(), store.load(), store.load()];
        const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
        expect(s1).toBe(s2);
        expect(s2).toBe(s3);
    });
});

// ─── Custom storageDirName (.codeatlas-sa for the standalone npm package) ─

describe('SnapshotStore — custom storageDirName', () => {
    let workspaceRoot: string;

    beforeEach(() => { workspaceRoot = mkWorkspace(); });
    afterEach(() => { rmrf(workspaceRoot); });

    it('defaults to .codeatlas when storageDirName is not provided', async () => {
        const store = new SnapshotStore(workspaceRoot);
        await store.load();
        store.save();
        expect(
            fs.existsSync(path.join(workspaceRoot, '.codeatlas', 'state.db')),
            'default storage path must be .codeatlas/state.db',
        ).toBe(true);
    });

    it('writes to the custom dir when storageDirName is .codeatlas-sa', async () => {
        const store = new SnapshotStore(workspaceRoot, { storageDirName: '.codeatlas-sa' });
        await store.load();
        store.save();
        expect(
            fs.existsSync(path.join(workspaceRoot, '.codeatlas-sa', 'state.db')),
            'standalone storage path must be .codeatlas-sa/state.db',
        ).toBe(true);
        expect(
            fs.existsSync(path.join(workspaceRoot, '.codeatlas', 'state.db')),
            'extension dir must NOT be created when standalone uses its own dir',
        ).toBe(false);
    });

    it('extension and standalone can coexist in the same workspace without lock contention', async () => {
        // Two stores pointing at separate dirs MUST be able to load + save
        // independently — the whole point of .codeatlas-sa is to avoid the
        // SQLite WAL lock the extension's .codeatlas/state.db holds.
        const ext = new SnapshotStore(workspaceRoot);
        const sa = new SnapshotStore(workspaceRoot, { storageDirName: '.codeatlas-sa' });
        await ext.load();
        await sa.load();
        ext.save();
        sa.save();
        expect(fs.existsSync(path.join(workspaceRoot, '.codeatlas', 'state.db'))).toBe(true);
        expect(fs.existsSync(path.join(workspaceRoot, '.codeatlas-sa', 'state.db'))).toBe(true);

        // Mutations on one snapshot don't leak to the other.
        ext.getWorking().apiIndex['ext-only'] = { apiId: 'ext-only', method: 'GET', route: '/ext', handlerName: 'h', filePath: 'src/e.ts' } as any;
        sa.getWorking().apiIndex['sa-only'] = { apiId: 'sa-only', method: 'GET', route: '/sa', handlerName: 'h', filePath: 'src/s.ts' } as any;
        ext.save();
        sa.save();

        // Reload each from disk; rows should NOT cross over.
        const extReload = new SnapshotStore(workspaceRoot);
        const saReload = new SnapshotStore(workspaceRoot, { storageDirName: '.codeatlas-sa' });
        await extReload.load();
        await saReload.load();
        expect(extReload.getWorking().apiIndex['ext-only'], 'extension snapshot kept its row').toBeDefined();
        expect(extReload.getWorking().apiIndex['sa-only'], 'extension snapshot must NOT see standalone rows').toBeUndefined();
        expect(saReload.getWorking().apiIndex['sa-only'], 'standalone snapshot kept its row').toBeDefined();
        expect(saReload.getWorking().apiIndex['ext-only'], 'standalone snapshot must NOT see extension rows').toBeUndefined();
    });
});

// ─── #535 dedup signature ─────────────────────────────────────────────────

describe('AI review signature (#535)', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    beforeEach(async () => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
        await store.load();
    });
    afterEach(() => { rmrf(workspaceRoot); });

    it('returns null when no review has ever completed', () => {
        expect(store.getAiReviewSignature()).toBeNull();
    });

    it('round-trips a signature through set/get', () => {
        store.setAiReviewSignature({
            guidelinesHash: 'g123',
            baselineKind: 'git',
            baselineRef: 'abc1234',
            findingsCount: 7,
        });
        const sig = store.getAiReviewSignature();
        expect(sig).not.toBeNull();
        expect(sig!.guidelinesHash).toBe('g123');
        expect(sig!.baselineKind).toBe('git');
        expect(sig!.baselineRef).toBe('abc1234');
        expect(sig!.findingsCount).toBe(7);
        expect(sig!.completedAt).toBeGreaterThan(0);
    });

    it('upsert overwrites previous signature', () => {
        store.setAiReviewSignature({ guidelinesHash: 'g1', baselineKind: 'git', baselineRef: 'aaaaaaa', findingsCount: 1 });
        store.setAiReviewSignature({ guidelinesHash: 'g2', baselineKind: 'snapshot', baselineRef: 'deadbeef', findingsCount: 4 });
        const sig = store.getAiReviewSignature();
        expect(sig!.guidelinesHash).toBe('g2');
        expect(sig!.baselineKind).toBe('snapshot');
        expect(sig!.findingsCount).toBe(4);
    });

    it('clearAiReviewSignature wipes the row', () => {
        store.setAiReviewSignature({ guidelinesHash: 'g', baselineKind: 'git', baselineRef: 'x', findingsCount: 1 });
        store.clearAiReviewSignature();
        expect(store.getAiReviewSignature()).toBeNull();
    });

    it('clearAiReviewFindings(no scope) also clears the signature', () => {
        store.setAiReviewSignature({ guidelinesHash: 'g', baselineKind: 'git', baselineRef: 'x', findingsCount: 1 });
        store.upsertAiReviewFinding({
            entryPointId: 'GET:/health',
            bindings: [{ graphId: 'file:src/x.ts', targetId: 'x', targetType: 'node', layer: 'file' }],
            severity: 'warning',
            category: 'code-quality',
            title: 't',
            body: 'b',
            status: 'open',
            model: 'test',
        } as any);
        store.clearAiReviewFindings();
        expect(store.getAiReviewSignature()).toBeNull();
    });

    it('clearAiReviewFindings(scoped) leaves signature alone', () => {
        store.setAiReviewSignature({ guidelinesHash: 'g', baselineKind: 'git', baselineRef: 'x', findingsCount: 1 });
        store.upsertAiReviewFinding({
            entryPointId: 'GET:/health',
            bindings: [{ graphId: 'file:src/x.ts', targetId: 'x', targetType: 'node', layer: 'file' }],
            severity: 'warning',
            category: 'code-quality',
            title: 't',
            body: 'b',
            status: 'open',
            model: 'test',
        } as any);
        store.clearAiReviewFindings({ entryPointId: 'GET:/health' });
        expect(store.getAiReviewSignature()).not.toBeNull();
    });
});

describe('markStaleFindings (#536)', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    function makeFinding(overrides: any = {}) {
        return {
            entryPointId: overrides.entryPointId ?? 'GET:/health',
            bindings: [{ graphId: 'file:src/x.ts', targetId: 'x', targetType: 'node', layer: 'file' }],
            severity: 'warning',
            category: 'code-quality',
            title: 't',
            body: 'b',
            status: 'open',
            model: 'test',
            guidelinesHash: 'g-old',
            baselineRef: { kind: 'git', ref: 'commit-old', capturedAt: new Date().toISOString() },
            ...overrides,
        };
    }

    beforeEach(async () => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
        await store.load();
    });
    afterEach(() => { rmrf(workspaceRoot); });

    it('flips open findings to stale when guidelines drift', () => {
        const f = store.upsertAiReviewFinding(makeFinding() as any);
        const ids = store.markStaleFindings({ currentGuidelinesHash: 'g-new', currentBaselineRef: 'commit-old' });
        expect(ids).toEqual([f.id]);
        const reload = store.listAiReviewFindings({ status: 'stale' } as any);
        expect(reload.map((x: any) => x.id)).toContain(f.id);
    });

    it('flips open findings to stale when baseline drifts', () => {
        const f = store.upsertAiReviewFinding(makeFinding() as any);
        const ids = store.markStaleFindings({ currentGuidelinesHash: 'g-old', currentBaselineRef: 'commit-new' });
        expect(ids).toEqual([f.id]);
    });

    it('no-op when neither guidelines nor baseline drifted', () => {
        store.upsertAiReviewFinding(makeFinding() as any);
        const ids = store.markStaleFindings({ currentGuidelinesHash: 'g-old', currentBaselineRef: 'commit-old' });
        expect(ids).toEqual([]);
        const all = store.listAiReviewFindings({} as any);
        expect(all.every((x: any) => x.status === 'open')).toBe(true);
    });

    it('does not touch findings that are already resolved / ignored', () => {
        const f1 = store.upsertAiReviewFinding(makeFinding({ status: 'open' }) as any);
        const f2 = store.upsertAiReviewFinding(makeFinding({ entryPointId: 'GET:/other', status: 'resolved' }) as any);
        const ids = store.markStaleFindings({ currentGuidelinesHash: 'g-new', currentBaselineRef: 'commit-old' });
        expect(ids).toEqual([f1.id]);
        const f2reloaded = store.listAiReviewFindings({} as any).find((x: any) => x.id === f2.id);
        expect(f2reloaded.status).toBe('resolved');
    });

    it('skips findings without a baselineRef when only baseline drifts', () => {
        // A finding from before baselineRef was tagged shouldn't get marked
        // stale on baseline drift alone — there's nothing to compare.
        const f = store.upsertAiReviewFinding(makeFinding({ baselineRef: undefined }) as any);
        const ids = store.markStaleFindings({ currentGuidelinesHash: 'g-old', currentBaselineRef: 'commit-new' });
        expect(ids).toEqual([]);
        const reload = store.listAiReviewFindings({} as any).find((x: any) => x.id === f.id);
        expect(reload.status).toBe('open');
    });
});

// #606 / #606-SYNTHETIC — per-entry review cursor (incremental review) ──
describe('AI review entry cursors (#606 / #606-SYNTHETIC)', () => {
    let workspaceRoot: string;
    let store: SnapshotStore;

    function makeCursor(apiId: string, entryPointId: string, over: Partial<any> = {}) {
        return {
            apiId,
            entryPointId,
            handlerHash: 'h1234567890ab',
            guidelinesHash: 'gh1',
            baselineKind: 'git',
            baselineRef: 'abc1234',
            reviewedAt: 100,
            ...over,
        };
    }

    beforeEach(async () => {
        workspaceRoot = mkWorkspace();
        store = new SnapshotStore(workspaceRoot);
        await store.load();
    });

    afterEach(() => { rmrf(workspaceRoot); });

    it('returns an empty map before any cursor has been written', () => {
        expect(store.getAiReviewEntryCursors()).toEqual({});
    });

    it('upserts a single cursor keyed by apiId and reads it back', () => {
        const apiId = 'GET:/api/users::src/users.controller.ts::list';
        store.upsertAiReviewEntryCursor(makeCursor(apiId, 'GET:/api/users'));
        const all = store.getAiReviewEntryCursors();
        expect(Object.keys(all)).toEqual([apiId]);
        expect(all[apiId]).toEqual(makeCursor(apiId, 'GET:/api/users'));
    });

    it('upsert is idempotent on apiId — second write updates in-place', () => {
        const apiId = 'GET:/x::src/x.ts::handler';
        store.upsertAiReviewEntryCursor(makeCursor(apiId, 'GET:/x', { handlerHash: 'h1', reviewedAt: 1 }));
        store.upsertAiReviewEntryCursor(makeCursor(apiId, 'GET:/x', { handlerHash: 'h2', reviewedAt: 2 }));
        const all = store.getAiReviewEntryCursors();
        expect(Object.keys(all)).toEqual([apiId]);
        expect(all[apiId].handlerHash).toBe('h2');
        expect(all[apiId].reviewedAt).toBe(2);
    });

    it('#606-SYNTHETIC: two cursors sharing entry_point_id coexist when apiIds differ', () => {
        // Two `useMutation()` call sites in two different files — same
        // entry_point_id, distinct apiIds. Pre-fix, the second upsert
        // would have collapsed the first; post-fix, both rows live.
        const sharedKey = 'NETWORK:mutation';
        const idA = 'NETWORK:mutation::frontend/src/A.tsx::useMutation';
        const idB = 'NETWORK:mutation::frontend/src/B.tsx::useMutation';
        store.upsertAiReviewEntryCursor(makeCursor(idA, sharedKey, { handlerHash: 'hA' }));
        store.upsertAiReviewEntryCursor(makeCursor(idB, sharedKey, { handlerHash: 'hB' }));
        const all = store.getAiReviewEntryCursors();
        expect(Object.keys(all).sort()).toEqual([idA, idB].sort());
        expect(all[idA].handlerHash).toBe('hA');
        expect(all[idB].handlerHash).toBe('hB');
    });

    it('clearAiReviewEntryCursorsByApiId removes only the listed apiIds', () => {
        store.upsertAiReviewEntryCursor(makeCursor('a1', 'GET:/a'));
        store.upsertAiReviewEntryCursor(makeCursor('a2', 'GET:/b'));
        store.upsertAiReviewEntryCursor(makeCursor('a3', 'GET:/c'));
        store.clearAiReviewEntryCursorsByApiId(['a1', 'a3']);
        expect(Object.keys(store.getAiReviewEntryCursors()).sort()).toEqual(['a2']);
    });

    it('clearAiReviewEntryCursorsByEntryPointId removes ALL cursors sharing the entry_point_id', () => {
        // Two cursors share `NETWORK:mutation`; clearing by entry_point_id
        // drops both rows in one go.
        store.upsertAiReviewEntryCursor(makeCursor('a1', 'NETWORK:mutation'));
        store.upsertAiReviewEntryCursor(makeCursor('a2', 'NETWORK:mutation'));
        store.upsertAiReviewEntryCursor(makeCursor('a3', 'GET:/x'));
        store.clearAiReviewEntryCursorsByEntryPointId(['NETWORK:mutation']);
        expect(Object.keys(store.getAiReviewEntryCursors())).toEqual(['a3']);
    });

    it('clearAllAiReviewEntryCursors wipes the table', () => {
        store.upsertAiReviewEntryCursor(makeCursor('a1', 'GET:/a'));
        store.upsertAiReviewEntryCursor(makeCursor('a2', 'GET:/b'));
        store.clearAllAiReviewEntryCursors();
        expect(store.getAiReviewEntryCursors()).toEqual({});
    });

    it('unscoped clearAiReviewFindings wipes the cursor table too (back-compat with #535 signature)', () => {
        store.upsertAiReviewEntryCursor(makeCursor('a1', 'GET:/a'));
        store.clearAiReviewFindings();
        expect(store.getAiReviewEntryCursors()).toEqual({});
    });

    it('scoped clearAiReviewFindings({ entryPointId }) removes every cursor sharing that entry_point_id', () => {
        // Two call sites share `NETWORK:mutation`; clearing the finding
        // scope by entry_point_id must drop both cursors so the next
        // review re-stamps fresh.
        store.upsertAiReviewEntryCursor(makeCursor('a1', 'NETWORK:mutation'));
        store.upsertAiReviewEntryCursor(makeCursor('a2', 'NETWORK:mutation'));
        store.upsertAiReviewEntryCursor(makeCursor('a3', 'GET:/keep'));
        store.clearAiReviewFindings({ entryPointId: 'NETWORK:mutation' });
        expect(Object.keys(store.getAiReviewEntryCursors())).toEqual(['a3']);
    });

    it('cursors survive a reopen of the store (sqlite persistence) — keyed by apiId', async () => {
        store.upsertAiReviewEntryCursor(makeCursor('GET:/persist::file.ts::sym', 'GET:/persist', { handlerHash: 'h1', reviewedAt: 42 }));
        store.save();
        const s2 = new SnapshotStore(workspaceRoot);
        await s2.load();
        const all = s2.getAiReviewEntryCursors();
        expect(all['GET:/persist::file.ts::sym']?.handlerHash).toBe('h1');
        expect(all['GET:/persist::file.ts::sym']?.reviewedAt).toBe(42);
        expect(all['GET:/persist::file.ts::sym']?.entryPointId).toBe('GET:/persist');
    });
});

// #829b (2026-06-11) — cross-process visibility. A read-only consumer (the
// MCP daemon while the extension holds the write lock) loads the sql.js
// image ONCE; later disk writes by the writer process are invisible until
// the image is re-opened. `reloadFromDiskIfChanged` stat-gates a re-open +
// rehydrate so pollers can track the writer cheaply.
describe('reloadFromDiskIfChanged (#829b)', () => {
    it('a second store instance sees the first instance\'s later writes after reload', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-829b-'));
        try {
            const writer = new SnapshotStore(dir);
            await writer.load();
            writer.updateWorkingFile('a.ts', { path: 'a.ts', hash: 'h1', mtime: 1, content: 'x', symbols: { functions: [], variables: [], imports: [] } } as any);
            writer.save();

            const reader = new SnapshotStore(dir);
            await reader.load();
            expect(reader.getWorking().files['a.ts']?.hash).toBe('h1');

            // Writer updates AFTER the reader loaded.
            await new Promise((r) => setTimeout(r, 30)); // ensure mtime tick
            writer.updateWorkingFile('a.ts', { path: 'a.ts', hash: 'h2', mtime: 2, content: 'y', symbols: { functions: [], variables: [], imports: [] } } as any);
            writer.save();

            // Stale until reloaded.
            expect(reader.getWorking().files['a.ts']?.hash).toBe('h1');
            const reloaded = await reader.reloadFromDiskIfChanged();
            expect(reloaded).toBe(true);
            expect(reader.getWorking().files['a.ts']?.hash).toBe('h2');

            writer.close(); reader.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('no disk change → returns false without rehydrating', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-829b-noop-'));
        try {
            const store = new SnapshotStore(dir);
            await store.load();
            store.updateWorkingFile('a.ts', { path: 'a.ts', hash: 'h1', mtime: 1, content: 'x', symbols: { functions: [], variables: [], imports: [] } } as any);
            store.save();
            // Our own save recorded the disk state — no external change.
            expect(await store.reloadFromDiskIfChanged()).toBe(false);
            expect(await store.reloadFromDiskIfChanged()).toBe(false);
            store.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('uninitialised store → false (no throw)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-829b-uninit-'));
        try {
            const store = new SnapshotStore(dir);
            expect(await store.reloadFromDiskIfChanged()).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
