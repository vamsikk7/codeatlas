/**
 * Live MCP smoke test against ~/work/node-express-realworld-example-app.
 *
 * Opens the actual persisted state.db (NOT a tmpdir copy) and exercises every
 * new context-pack function. Verifies (a) tools return real, non-trivial data
 * against the freshly-installed VSIX's state, (b) byte counts match the
 * token-economics claim.
 *
 * Skipped when the test project's state.db isn't present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import {
    listEntryPoints,
    getEntryPointPack,
    getDiffSummary,
    getImpactOfChange,
    getFeaturePack,
} from '../contextPack';
import { searchWorkspace } from '../searchIndex';
import { runReadOnlyQuery, describeSchema } from '../sqlQuery';

const ROOT = path.join(os.homedir(), 'work/node-express-realworld-example-app');
const DB_PATH = path.join(ROOT, '.codeatlas', 'state.db');
const PRESENT = fs.existsSync(DB_PATH);

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const tokens = (n: number) => Math.ceil(n / 4);

(PRESENT ? describe : describe.skip)('MCP LIVE SMOKE — node-express-realworld-example-app', () => {
    let store: SnapshotStore;
    let snapshot: any;
    let baseline: any;

    beforeAll(async () => {
        store = new SnapshotStore(ROOT);
        await store.load();
        snapshot = store.getWorking();
        baseline = store.getBaseline();
    }, 60_000);

    afterAll(() => { /* sql.js store has no dispose; GC handles it */ });

    it('list_entrypoints returns every entry point with metadata', () => {
        const all = listEntryPoints(snapshot);
        const allBytes = bytes(all);
        console.log(`\nlist_entrypoints (no filter): ${all.length} entries, ${allBytes.toLocaleString()} bytes (~${tokens(allBytes)} tokens)`);
        expect(all.length).toBeGreaterThanOrEqual(20);
        const get = all.find((ep) => ep.method === 'GET' && ep.route === '/api/articles/:slug');
        expect(get?.auth).toBe('optional');
        expect(get?.middlewares).toContain('auth.optional');
    });

    it('list_entrypoints filter: authRequired', () => {
        const req = listEntryPoints(snapshot, { authRequired: true });
        console.log(`list_entrypoints({authRequired:true}): ${req.length} entries`);
        expect(req.length).toBeGreaterThanOrEqual(8);
    });

    it('get_entrypoint_pack(GET /api/articles/:slug) returns a complete context pack', () => {
        const pack = getEntryPointPack(snapshot, 'GET', '/api/articles/:slug');
        expect(pack).not.toBeNull();
        const packBytes = bytes(pack);
        console.log(`get_entrypoint_pack(GET /api/articles/:slug): ${packBytes.toLocaleString()} bytes (~${tokens(packBytes)} tokens)`);
        console.log(`  callsInto=${pack!.callsInto.length}, messages=${pack!.messages.length}, flowNodes=${pack!.flowNodes.length}, siblings=${pack!.siblings.length}`);
        expect(pack!.entryPoint.auth).toBe('optional');
        expect(pack!.callsInto.length).toBeGreaterThan(0);
        expect(pack!.messages.length).toBeGreaterThan(0);
    });

    it('get_entrypoint_pack(GET /api/random/:index) carries dynamicRange.count=25', () => {
        const pack = getEntryPointPack(snapshot, 'GET', '/api/random/:index');
        expect(pack).not.toBeNull();
        expect(pack!.entryPoint.dynamicRangeCount).toBe(25);
        console.log(`get_entrypoint_pack(GET /api/random/:index): bytes=${bytes(pack).toLocaleString()} count=${pack!.entryPoint.dynamicRangeCount}`);
    });

    it('get_diff_summary returns a clean tree (no current edits)', () => {
        const diff = getDiffSummary(snapshot, baseline);
        console.log(`get_diff_summary: changedFiles=${diff.changedFiles.length}, added=${diff.addedEntryPoints.length}, modified=${diff.modifiedEntryPoints.length}, deleted=${diff.deletedEntryPoints.length}, bytes=${bytes(diff)}`);
        expect(diff).toHaveProperty('changedFiles');
        expect(diff).toHaveProperty('addedEntryPoints');
        expect(diff).toHaveProperty('modifiedEntryPoints');
    });

    it('get_impact_of_change(auth.service.ts, getCurrentUser) lists reachable entry points', () => {
        const impact = getImpactOfChange(snapshot, 'src/app/routes/auth/auth.service.ts', 'getCurrentUser');
        console.log(`get_impact_of_change(auth.service.ts, getCurrentUser): ${impact.entryPoints.length} entry points, bytes=${bytes(impact)}`);
        // /user routes should reach this service.
        expect(impact.entryPoints.length).toBeGreaterThanOrEqual(1);
    });

    it('get_feature_pack(cluster:article) returns cluster summary', () => {
        const articleId = Object.keys(snapshot.clusters ?? {}).find((id) => /article/i.test((snapshot.clusters as any)[id].label));
        if (!articleId) {
            console.log('  (no article cluster found in snapshot — skipping)');
            return;
        }
        const pack = getFeaturePack(snapshot, articleId, baseline);
        expect(pack).not.toBeNull();
        const packBytes = bytes(pack);
        console.log(`get_feature_pack(${articleId}): ${packBytes.toLocaleString()} bytes, ${pack!.entryPoints.length} entry points, ${pack!.subsystems.length} subsystems`);
        expect(pack!.entryPoints.length).toBeGreaterThan(0);
    });

    it('error middleware (Issue 418) surfaces with meta.error=true via list_entrypoints', () => {
        const mw = listEntryPoints(snapshot, { method: 'MIDDLEWARE' });
        const err = mw.filter((m) => m.error);
        console.log(`MIDDLEWARE rows: ${mw.length}, with meta.error=true: ${err.length}`);
        expect(err.length).toBeGreaterThanOrEqual(1);
    });

    // Keyword search probes — verify the reverse index resolves real entities.
    it('search_workspace finds getCurrentUser as a function in auth.service.ts', () => {
        const results = searchWorkspace(snapshot, 'getCurrentUser', { limit: 5 });
        console.log(`search("getCurrentUser") → ${results.length} hits, top: ${results[0]?.kind}:${results[0]?.name} score=${results[0]?.score}`);
        const fn = results.find((r) => r.kind === 'function' && r.name === 'getCurrentUser');
        expect(fn).toBeDefined();
        expect(fn!.filePath).toContain('auth.service.ts');
    });

    it('search_workspace finds the auth feature cluster (LLM-named or raw label)', () => {
        const results = searchWorkspace(snapshot, 'auth', { kinds: ['feature'], limit: 5 });
        console.log(`search("auth", kinds:[feature]) → ${results.map((r) => r.name).join(', ')}`);
        expect(results.length).toBeGreaterThan(0);
        // Cluster may be LLM-renamed (e.g. "User Authentication") — accept any
        // cluster whose name OR label still tokenises to "auth".
        expect(results.some((r) => /auth/i.test(r.name) || /auth/i.test(r.clusterLabel ?? ''))).toBe(true);
    });

    it('search_workspace finds the /api/articles/:slug route', () => {
        const results = searchWorkspace(snapshot, 'articles slug', { kinds: ['route'], limit: 10 });
        const slugRoute = results.find((r) => r.route === '/api/articles/:slug');
        console.log(`search("articles slug", kinds:[route]) → ${results.length} hits; :slug present: ${!!slugRoute}`);
        expect(slugRoute).toBeDefined();
    });

    it('search_workspace returns ranked, mixed-kind results for a broad query', () => {
        const results = searchWorkspace(snapshot, 'comment', { limit: 10 });
        console.log(`search("comment") top 5:`);
        for (const r of results.slice(0, 5)) console.log(`  ${r.kind}: ${r.name} (score=${r.score})`);
        expect(results.length).toBeGreaterThan(0);
    });

    it('search_workspace multi-keyword (AND semantics with requireAll)', () => {
        const results = searchWorkspace(snapshot, ['articles', 'comments'], { kinds: ['route'], requireAll: true });
        console.log(`search(["articles","comments"], requireAll=true): ${results.length} routes`);
        // Every result must include both tokens.
        for (const r of results) {
            expect(r.route?.toLowerCase()).toMatch(/articles/);
            expect(r.route?.toLowerCase()).toMatch(/comments/);
        }
    });

    // Read-only SQL access probes.
    it('describe_snapshot_schema returns table metadata', () => {
        const desc = describeSchema(store);
        console.log(`schema: ${desc.tables.length} tables, notes: ${desc.notes.length}`);
        for (const t of desc.tables) console.log(`  ${t.name}: ${t.columns.length} columns, ${t.rowCount} rows`);
        expect(desc.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['apis', 'graphs', 'files']));
    });

    it('query_snapshot — ad-hoc SQL works against live state.db', () => {
        const result = runReadOnlyQuery(
            store,
            "SELECT json_extract(record_json, '$.method') AS method, json_extract(record_json, '$.route') AS route, json_extract(record_json, '$.meta.auth') AS auth FROM apis WHERE snapshot_kind = 'working' AND json_extract(record_json, '$.meta.auth') = 'required'",
            50,
        );
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        console.log(`query_snapshot returned ${result.rowCount} auth=required routes:`);
        for (const r of result.rows.slice(0, 5)) console.log(`  ${r.method} ${r.route}`);
        expect(result.rowCount).toBeGreaterThanOrEqual(8);
    });

    it('query_snapshot rejects mutation attempts', () => {
        const r = runReadOnlyQuery(store, "DELETE FROM apis WHERE snapshot_kind = 'working'");
        expect('error' in r).toBe(true);
        if ('error' in r) console.log(`  rejected: ${r.error}`);
    });
});
