/**
 * gitDiffStore.test.ts
 *
 * Tests for GitDiffStore — load/save/clear lifecycle of the persisted git
 * diff session. Backend changed in #349 from a JSON file to the
 * consolidated SQLite store; assertions now query the DB through the
 * GitDiffStore API rather than reading a file from disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GitDiffStore, type PersistedGitDiffState } from '../gitDiffStore';
import { GitRefProvider } from '../gitRefProvider';
import { SqliteStore } from '../sqliteStore';
import type { DiagramGraph } from '../../graph/graphTypes';

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-git-diff-store-'));
}

function makeMinimalGraph(graphId: string): DiagramGraph {
    return {
        graphId,
        type: 'file',
        nodes: [{ id: 'n1', type: 'function', label: 'foo', diff: 'added' }],
        edges: [],
        anchors: {},
        meta: {},
    };
}

function makeState(overrides: Partial<PersistedGitDiffState> = {}): PersistedGitDiffState {
    return {
        baseHash: 'aaaaaaa',
        headHash: 'bbbbbbb',
        baseLabel: 'aaaaaaa fix: old commit',
        headLabel: 'bbbbbbb feat: new commit',
        diffedGraphs: {
            'file:src/index.ts': makeMinimalGraph('file:src/index.ts'),
        },
        apiIndex: {},
        ...overrides,
    };
}

async function makeSqlite(workspaceRoot: string): Promise<SqliteStore> {
    const provider = new GitRefProvider(workspaceRoot);
    const sqlite = new SqliteStore(workspaceRoot, provider);
    await sqlite.init();
    return sqlite;
}

describe('GitDiffStore', () => {
    let tmpDir: string;
    let sqlite: SqliteStore;
    let store: GitDiffStore;

    beforeEach(async () => {
        tmpDir = makeTmpDir();
        sqlite = await makeSqlite(tmpDir);
        store = new GitDiffStore(tmpDir, sqlite);
    });

    afterEach(() => {
        sqlite.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('load', () => {
        it('returns null when no session exists', () => {
            expect(store.load()).toBeNull();
        });

        it('returns null when legacy file is invalid JSON', () => {
            const dir = path.join(tmpDir, '.codeatlas');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'git-diff-state.json'), '{ bad json }', 'utf-8');
            expect(store.load()).toBeNull();
        });

        it('imports a legacy git-diff-state.json on first load', () => {
            const dir = path.join(tmpDir, '.codeatlas');
            fs.mkdirSync(dir, { recursive: true });
            const legacy = makeState({ baseHash: 'legacy1', headHash: 'legacy2' });
            fs.writeFileSync(path.join(dir, 'git-diff-state.json'), JSON.stringify(legacy));
            const loaded = store.load();
            expect(loaded?.baseHash).toBe('legacy1');
            expect(loaded?.headHash).toBe('legacy2');
        });

        it('returns the persisted state after a save', () => {
            const state = makeState();
            store.save(state);
            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded!.baseHash).toBe(state.baseHash);
            expect(loaded!.headHash).toBe(state.headHash);
            expect(loaded!.baseLabel).toBe(state.baseLabel);
            expect(loaded!.headLabel).toBe(state.headLabel);
        });
    });

    describe('save', () => {
        it('persists exactly one row in git_diff_sessions', () => {
            store.save(makeState());
            const n = Number(sqlite.get('SELECT COUNT(*) AS n FROM git_diff_sessions')?.n);
            expect(n).toBe(1);
        });

        it('persists the diffedGraphs correctly', () => {
            store.save(makeState());
            const loaded = store.load();
            expect(loaded!.diffedGraphs['file:src/index.ts']).toBeDefined();
            expect(loaded!.diffedGraphs['file:src/index.ts'].graphId).toBe('file:src/index.ts');
            expect(loaded!.diffedGraphs['file:src/index.ts'].nodes[0].diff).toBe('added');
        });

        it('overwrites an existing row on subsequent saves', () => {
            store.save(makeState({ baseHash: 'aaaaaa1', headHash: 'bbbbbbb' }));
            store.save(makeState({ baseHash: 'aaaaaa2', headHash: 'ccccccc' }));
            const loaded = store.load();
            expect(loaded!.baseHash).toBe('aaaaaa2');
            expect(loaded!.headHash).toBe('ccccccc');
            // Still only one row.
            const n = Number(sqlite.get('SELECT COUNT(*) AS n FROM git_diff_sessions')?.n);
            expect(n).toBe(1);
        });

        it('persists large diffedGraphs without truncation', () => {
            const manyGraphs: Record<string, DiagramGraph> = {};
            for (let i = 0; i < 100; i++) {
                const id = `file:src/module${i}.ts`;
                manyGraphs[id] = makeMinimalGraph(id);
            }
            store.save(makeState({ diffedGraphs: manyGraphs }));
            const loaded = store.load();
            expect(Object.keys(loaded!.diffedGraphs)).toHaveLength(100);
        });

        it('round-trips an empty apiIndex', () => {
            store.save(makeState({ apiIndex: {} }));
            const loaded = store.load();
            expect(loaded!.apiIndex).toEqual({});
        });

        it('round-trips an apiIndex with entries', () => {
            store.save(makeState({
                apiIndex: {
                    'api:src/routes.ts:GET:/items': {
                        apiId: 'api:src/routes.ts:GET:/items',
                        method: 'GET',
                        route: '/items',
                        handlerName: 'listItems',
                        filePath: 'src/routes.ts',
                        anchor: { filePath: 'src/routes.ts' },
                    },
                },
            }));
            const loaded = store.load();
            expect(Object.keys(loaded!.apiIndex)).toHaveLength(1);
            expect(loaded!.apiIndex['api:src/routes.ts:GET:/items'].route).toBe('/items');
        });

        it('flushes to disk so a fresh store sees the row', async () => {
            store.save(makeState({ baseHash: 'persist1' }));
            sqlite.close();
            const sqlite2 = await makeSqlite(tmpDir);
            try {
                const store2 = new GitDiffStore(tmpDir, sqlite2);
                expect(store2.load()?.baseHash).toBe('persist1');
            } finally {
                sqlite2.close();
            }
        });
    });

    describe('clear', () => {
        it('removes the row from git_diff_sessions', () => {
            store.save(makeState());
            store.clear();
            expect(store.load()).toBeNull();
            const n = Number(sqlite.get('SELECT COUNT(*) AS n FROM git_diff_sessions')?.n);
            expect(n).toBe(0);
        });

        it('also deletes the legacy file if it lingered', () => {
            const dir = path.join(tmpDir, '.codeatlas');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'git-diff-state.json'), JSON.stringify(makeState()));
            store.clear();
            expect(fs.existsSync(path.join(dir, 'git-diff-state.json'))).toBe(false);
        });

        it('is idempotent (no row, no file → no throw)', () => {
            expect(() => store.clear()).not.toThrow();
            expect(() => store.clear()).not.toThrow();
        });
    });

    describe('save → clear → save round-trip', () => {
        it('can save a new state after clearing', () => {
            store.save(makeState({ baseHash: 'aaaaaaa', headHash: 'bbbbbbb' }));
            store.clear();
            store.save(makeState({ baseHash: 'ccccccc', headHash: 'ddddddd' }));
            const loaded = store.load();
            expect(loaded!.baseHash).toBe('ccccccc');
            expect(loaded!.headHash).toBe('ddddddd');
        });
    });

    // UX-64 Phase 3 (2026-06-09) — persistence of the `scopedRepo` field
    // so a per-repo diff session round-trips through disk. Full multi-
    // scope persistence (one row per scope) is gated on a schema change
    // (replace the `id = 1` PK with a `scope` PK); this slice covers the
    // single-row-with-scope shape that the registry already produces.
    describe('UX-64 Phase 3 — scopedRepo persistence', () => {
        it('omits scopedRepo for a workspace-wide session', () => {
            const state = makeState();
            expect(state.scopedRepo).toBeUndefined();
            store.save(state);
            const loaded = store.load();
            expect(loaded!.scopedRepo).toBeUndefined();
        });

        it('round-trips scopedRepo through save → load', () => {
            const state = makeState({ scopedRepo: 'service-a' });
            store.save(state);
            const loaded = store.load();
            expect(loaded!.scopedRepo).toBe('service-a');
        });

        it('round-trips scoped labels alongside scopedRepo', () => {
            const state = makeState({
                scopedRepo: 'payments-svc',
                baseLabel: 'Baseline (payments-svc)',
                headLabel: 'Working uncommitted (payments-svc)',
            });
            store.save(state);
            const loaded = store.load();
            expect(loaded!.scopedRepo).toBe('payments-svc');
            expect(loaded!.baseLabel).toBe('Baseline (payments-svc)');
            expect(loaded!.headLabel).toBe('Working uncommitted (payments-svc)');
        });

        it('overwriting with a different scope replaces the previous scope', () => {
            store.save(makeState({ scopedRepo: 'service-a' }));
            store.save(makeState({ scopedRepo: 'service-b' }));
            const loaded = store.load();
            expect(loaded!.scopedRepo).toBe('service-b');
        });
    });
});
