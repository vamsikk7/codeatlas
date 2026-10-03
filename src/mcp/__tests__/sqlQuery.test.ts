/**
 * sqlQuery.test.ts — guardrail + result tests for the read-only SQL endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { runReadOnlyQuery, describeSchema } from '../sqlQuery';

let store: SnapshotStore;
let workspaceRoot: string;

beforeAll(async () => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlquery-test-'));
    store = new SnapshotStore(workspaceRoot);
    await store.load();
    // Seed: the `apis` table has an FK to `snapshots(kind)` and `snapshots`
    // requires a `git_ref_id`. The cleanest seed is to call store.save() with
    // a hand-rolled working snapshot — that handles every FK + schema concern.
    const working = store.getWorking();
    working.apiIndex['GET:/x::src/a.ts::handlerA'] = {
        apiId: 'GET:/x::src/a.ts::handlerA',
        method: 'GET',
        route: '/x',
        handlerName: 'handlerA',
        filePath: 'src/a.ts',
        anchor: { filePath: 'src/a.ts' },
        meta: { auth: 'required' },
    };
    working.apiIndex['POST:/y::src/b.ts::handlerB'] = {
        apiId: 'POST:/y::src/b.ts::handlerB',
        method: 'POST',
        route: '/y',
        handlerName: 'handlerB',
        filePath: 'src/b.ts',
        anchor: { filePath: 'src/b.ts' },
    };
    store.save();
});

afterAll(() => {
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe('runReadOnlyQuery', () => {
    it('returns rows for a basic SELECT', () => {
        const result = runReadOnlyQuery(store, "SELECT api_id FROM apis WHERE snapshot_kind = 'working'");
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.rowCount).toBe(2);
        expect(result.columns).toContain('api_id');
    });

    it('supports JSON column extraction', () => {
        const result = runReadOnlyQuery(
            store,
            "SELECT json_extract(record_json, '$.method') AS method, json_extract(record_json, '$.route') AS route FROM apis WHERE snapshot_kind = 'working'",
        );
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.rows.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    });

    it('caps row count via limit option', () => {
        const result = runReadOnlyQuery(store, "SELECT api_id FROM apis WHERE snapshot_kind = 'working'", 1);
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.rowCount).toBe(1);
        expect(result.truncated).toBe(true);
    });

    it('supports CTEs via WITH ... SELECT', () => {
        const result = runReadOnlyQuery(
            store,
            "WITH t AS (SELECT api_id FROM apis WHERE snapshot_kind = 'working') SELECT count(*) AS c FROM t",
        );
        if ('error' in result) {
            // Surface the actual SQL error so the next iteration knows the shape.
            console.log('CTE failed:', result);
        }
        expect('error' in result).toBe(false);
        if ('error' in result) return;
        expect(result.rows[0].c).toBe(2);
    });

    describe('guardrails', () => {
        it('rejects empty / non-string input', () => {
            expect((runReadOnlyQuery(store, '') as any).error).toMatch(/non-empty/);
            expect((runReadOnlyQuery(store, null as any) as any).error).toMatch(/non-empty/);
        });

        it('rejects DELETE', () => {
            const r = runReadOnlyQuery(store, "DELETE FROM apis");
            expect((r as any).error).toMatch(/only SELECT/);
        });

        it('rejects INSERT/UPDATE/DROP/ALTER/CREATE', () => {
            for (const stmt of [
                "INSERT INTO apis VALUES (1, 'x', '{}')",
                "UPDATE apis SET api_id = 'x'",
                "DROP TABLE apis",
                "ALTER TABLE apis ADD COLUMN x INT",
                "CREATE TABLE evil (x INT)",
            ]) {
                const r = runReadOnlyQuery(store, stmt);
                expect((r as any).error).toMatch(/only SELECT|forbidden/i);
            }
        });

        it('rejects forbidden keywords embedded in a SELECT', () => {
            const r = runReadOnlyQuery(store, "SELECT 1 FROM apis WHERE 1=1 OR DROP");
            expect((r as any).error).toMatch(/forbidden/i);
        });

        it('rejects multi-statement queries', () => {
            const r = runReadOnlyQuery(store, "SELECT 1 FROM apis; SELECT 2 FROM apis");
            expect((r as any).error).toMatch(/multiple statements/);
        });

        it('#889 — rejects filesystem / extension-loading functions (no FROM, no DML keyword)', () => {
            for (const stmt of [
                "SELECT readfile('/etc/passwd')",
                "SELECT load_extension('evil.so')",
                "SELECT writefile('/tmp/x', 'data')",
                "SELECT fts3_tokenizer('x')",
            ]) {
                const r = runReadOnlyQuery(store, stmt);
                expect('error' in r, `expected ${stmt} to be rejected`).toBe(true);
                expect((r as any).error).toMatch(/forbidden function/i);
            }
        });

        it('#889 — does NOT false-reject a column/string that merely contains a function name', () => {
            // `readfile` as a quoted string literal must not trip the guard.
            const r = runReadOnlyQuery(store, "SELECT api_id FROM apis WHERE api_id = 'readfile-route'");
            // It runs (or returns rows) — the point is it is NOT a forbidden-function error.
            expect((r as any).error ?? '').not.toMatch(/forbidden function/i);
        });

        it('rejects queries against unknown tables', () => {
            const r = runReadOnlyQuery(store, "SELECT * FROM secret_table");
            expect((r as any).error).toMatch(/table not allowed/);
            expect((r as any).hint).toContain('apis');
        });

        it('allows queries against the v2 FE/mobile data tables', () => {
            // services / clusters / screens / screen_items must not error
            // with `table not allowed` — they're part of the read-only
            // SQL surface so MCP agents can answer FE/mobile questions.
            for (const tbl of ['services', 'clusters', 'screens', 'screen_items']) {
                const r = runReadOnlyQuery(store, `SELECT COUNT(*) AS n FROM ${tbl}`);
                expect('error' in r, `expected ${tbl} to be allowed, got: ${(r as any).error}`).toBe(false);
            }
        });

        it('rejects queries longer than the length cap', () => {
            const huge = 'SELECT ' + ('a, '.repeat(10_000)) + ' 1 FROM apis';
            const r = runReadOnlyQuery(store, huge);
            expect((r as any).error).toMatch(/max length/);
        });

        it('allows the keyword INSIDE a string literal (false positive guard)', () => {
            const r = runReadOnlyQuery(store, "SELECT api_id FROM apis WHERE api_id LIKE 'GET:%' AND api_id LIKE '%delete%'");
            // 'delete' is inside a string literal so the FORBIDDEN check should
            // strip it first and the query should run cleanly.
            expect('error' in r).toBe(false);
        });

        it('reports SQL errors as structured errors not throws', () => {
            const r = runReadOnlyQuery(store, "SELECT nonexistent_col FROM apis");
            expect((r as any).error).toMatch(/sql error/i);
        });
    });
});

describe('describeSchema', () => {
    it('returns schema with apis + graphs + files', () => {
        const desc = describeSchema(store);
        const tableNames = desc.tables.map((t) => t.name);
        expect(tableNames).toEqual(expect.arrayContaining(['apis', 'graphs', 'files', 'snapshots']));
        expect(desc.notes.length).toBeGreaterThan(3);
    });

    it('reports row counts on each table', () => {
        const desc = describeSchema(store);
        const apis = desc.tables.find((t) => t.name === 'apis');
        expect(apis?.rowCount).toBe(2);
    });

    it('describes columns + primary keys', () => {
        const desc = describeSchema(store);
        const apis = desc.tables.find((t) => t.name === 'apis');
        expect(apis?.columns.some((c) => c.name === 'api_id')).toBe(true);
        expect(apis?.columns.some((c) => c.pk)).toBe(true);
    });
});
