/**
 * sqliteStore.test.ts
 *
 * Foundation-level tests for the consolidated SQLite store: schema migration,
 * git_ref upsert + cascade clear, low-level helpers, transaction rollback,
 * tmp+rename flush.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteStore, CURRENT_SCHEMA_VERSION } from '../sqliteStore';
import { GitRefProvider, PRE_GIT_REF } from '../gitRefProvider';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-sqlitestore-'));
}

async function makeStore(workspaceRoot: string): Promise<SqliteStore> {
    const provider = new GitRefProvider(workspaceRoot);
    const store = new SqliteStore(workspaceRoot, provider);
    await store.init();
    return store;
}

describe('SqliteStore — foundation', () => {
    let workspaceRoot: string;
    let store: SqliteStore;

    beforeEach(async () => {
        workspaceRoot = tmp();
        store = await makeStore(workspaceRoot);
    });

    afterEach(() => {
        store.close();
        try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('migrates an empty DB to CURRENT_SCHEMA_VERSION', () => {
        const row = store.get('PRAGMA user_version');
        expect(Number(row?.user_version)).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('creates all expected tables', () => {
        const expected = [
            'git_refs', 'snapshots', 'files', 'apis', 'graphs',
            'clusters', 'services', 'singletons', 'comments',
            'llm_cluster_names', 'llm_service_descriptions',
            'llm_api_annotations', 'git_diff_sessions', 'change_log',
            'settings',
        ];
        const rows = store.all(`SELECT name FROM sqlite_master WHERE type='table'`);
        const names = rows.map(r => String(r.name));
        for (const t of expected) expect(names).toContain(t);
    });

    it('foreign keys are enforced for the rest of this connection', () => {
        // Try to insert a snapshot row pointing at a non-existent git_ref.
        expect(() =>
            store.run(
                'INSERT INTO snapshots (kind, git_ref_id, schema_version, updated_at) VALUES (?, ?, ?, ?)',
                ['baseline', 9999, 1, Date.now()],
            ),
        ).toThrow();
    });

    it('upsertGitRef inserts the pre-git sentinel and returns its id', () => {
        const id = store.upsertGitRef(PRE_GIT_REF);
        expect(typeof id).toBe('number');
        const row = store.get('SELECT sha FROM git_refs WHERE id = ?', [id]);
        expect(row?.sha).toBe(PRE_GIT_REF);
    });

    it('upsertGitRef is idempotent for the same SHA', () => {
        const a = store.upsertGitRef('abcdef0123456789abcdef0123456789abcdef01');
        const b = store.upsertGitRef('abcdef0123456789abcdef0123456789abcdef01');
        expect(a).toBe(b);
        const count = store.get('SELECT COUNT(*) AS n FROM git_refs');
        expect(Number(count?.n)).toBe(1);
    });

    it('upsertGitRef rejects malformed SHAs by falling back to pre-git', () => {
        const id = store.upsertGitRef('not-a-sha');
        const row = store.get('SELECT sha FROM git_refs WHERE id = ?', [id]);
        expect(row?.sha).toBe(PRE_GIT_REF);
    });

    it('clear() cascades through every child table', () => {
        const refId = store.upsertGitRef(PRE_GIT_REF);
        store.run(
            'INSERT INTO snapshots (kind, git_ref_id, schema_version, updated_at) VALUES (?, ?, ?, ?)',
            ['baseline', refId, 1, Date.now()],
        );
        store.run(
            `INSERT INTO files (snapshot_kind, path, record_json) VALUES (?, ?, ?)`,
            ['baseline', 'src/a.ts', '{}'],
        );
        store.run(
            `INSERT INTO comments (id, git_ref_id, comment_json, created_at) VALUES (?, ?, ?, ?)`,
            ['c1', refId, '{}', Date.now()],
        );
        // Sanity: rows exist.
        expect(Number(store.get('SELECT COUNT(*) AS n FROM snapshots')?.n)).toBe(1);
        expect(Number(store.get('SELECT COUNT(*) AS n FROM files')?.n)).toBe(1);
        expect(Number(store.get('SELECT COUNT(*) AS n FROM comments')?.n)).toBe(1);

        store.clear();

        // Every table empty.
        for (const t of ['git_refs', 'snapshots', 'files', 'comments']) {
            const n = Number(store.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n);
            expect(n, `table ${t} should be empty after clear()`).toBe(0);
        }
    });

    it('transaction rolls back on throw', () => {
        store.upsertGitRef(PRE_GIT_REF);
        const before = Number(store.get('SELECT COUNT(*) AS n FROM git_refs')?.n);
        expect(() =>
            store.transaction(() => {
                store.upsertGitRef('1111111111111111111111111111111111111111');
                throw new Error('forced');
            }),
        ).toThrow('forced');
        const after = Number(store.get('SELECT COUNT(*) AS n FROM git_refs')?.n);
        expect(after).toBe(before);
    });

    it('flush() writes the DB to disk and survives a re-open', async () => {
        const sha = '2222222222222222222222222222222222222222';
        store.upsertGitRef(sha);
        store.flush();
        store.close();

        const dbPath = path.join(workspaceRoot, '.codeatlas', 'state.db');
        expect(fs.existsSync(dbPath)).toBe(true);

        // Re-open: rows should still be there.
        const reopened = await makeStore(workspaceRoot);
        try {
            const row = reopened.get('SELECT sha FROM git_refs WHERE sha = ?', [sha]);
            expect(row?.sha).toBe(sha);
        } finally {
            reopened.close();
        }
    });

    it('flush() is atomic (write-then-rename leaves no .tmp behind)', () => {
        store.upsertGitRef(PRE_GIT_REF);
        store.flush();
        const tmpPath = path.join(workspaceRoot, '.codeatlas', 'state.db.tmp');
        expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('refuses to open a DB written by a newer schema version', async () => {
        // Bump user_version past CURRENT_SCHEMA_VERSION and flush, then re-open.
        store.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
        store.flush();
        store.close();
        const provider = new GitRefProvider(workspaceRoot);
        const reopened = new SqliteStore(workspaceRoot, provider);
        await expect(reopened.init()).rejects.toThrow(/newer than supported/);
    });
});
