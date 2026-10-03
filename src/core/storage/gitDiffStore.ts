import * as fs from 'fs';
import * as path from 'path';
import type { DiagramGraph, ApiRecord } from '../graph/graphTypes';
import { SqliteStore } from './sqliteStore';

const STORAGE_DIR = '.codeatlas';
const LEGACY_FILE = 'git-diff-state.json';

export interface PersistedGitDiffState {
    baseHash: string;
    headHash: string;
    baseLabel: string;
    headLabel: string;
    diffedGraphs: Record<string, DiagramGraph>;
    apiIndex: Record<string, ApiRecord>;
    // UX-63 (2026-06-09) — per-repo diff sessions stamp the sub-repo
    // name so consumers (AI Review scope picker, replay HUD label,
    // future per-repo gitDiffState keying) can distinguish from
    // workspace-wide sessions. Optional + serialized as-is.
    scopedRepo?: string;
}

/**
 * Persists the active git diff session into the consolidated SQLite store
 * (`git_diff_sessions` table). At most one active session per workspace,
 * enforced by the `id = 1` PK CHECK in the schema.
 *
 * The legacy `.codeatlas/git-diff-state.json` is auto-imported on first
 * load() if present (and the DB has no session yet). The file is left on
 * disk so the user can verify before deleting.
 */
export class GitDiffStore {
    private readonly workspaceRoot: string;
    private readonly sqlite: SqliteStore;
    private log: (msg: string) => void = () => { /* noop */ };

    constructor(workspaceRoot: string, sqlite: SqliteStore) {
        this.workspaceRoot = workspaceRoot;
        this.sqlite = sqlite;
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    load(scope?: string): PersistedGitDiffState | null {
        try {
            // UX-64 Phase 3 (2026-06-09) — read from the scoped v2 table
            // first. Falls back to the legacy single-row table so per-repo
            // diff sessions written before this change still load.
            const wantedScope = scope ?? 'workspace';
            const v2 = this.sqlite.get(
                `SELECT base_hash, head_hash, base_label, head_label, state_json FROM git_diff_sessions_v2 WHERE scope = ?`,
                [wantedScope],
            );
            if (v2) return this.rowToState(v2);
            const row = this.sqlite.get(`SELECT base_hash, head_hash, base_label, head_label, state_json FROM git_diff_sessions WHERE id = 1`);
            if (row) {
                return this.rowToState(row);
            }
            const legacy = this.tryReadLegacy();
            if (legacy) {
                this.save(legacy);
                return legacy;
            }
            return null;
        } catch (err: any) {
            this.log(`[GitDiffStore] Failed to load: ${err?.message ?? err}`);
            return null;
        }
    }

    /**
     * UX-64 Phase 3 (2026-06-09) — every scoped diff session stored in v2.
     * Used by the per-repo restoration path so all active sessions come
     * back after a workspace reload, not just the last-written one.
     */
    loadAllScopes(): Array<{ scope: string; state: PersistedGitDiffState }> {
        try {
            const rows = this.sqlite.all(
                `SELECT scope, base_hash, head_hash, base_label, head_label, state_json FROM git_diff_sessions_v2`,
            ) as Array<Record<string, any>>;
            const out: Array<{ scope: string; state: PersistedGitDiffState }> = [];
            for (const r of rows) {
                const state = this.rowToState(r);
                if (state) out.push({ scope: String(r.scope), state });
            }
            return out;
        } catch (err: any) {
            this.log(`[GitDiffStore] Failed to loadAllScopes: ${err?.message ?? err}`);
            return [];
        }
    }

    save(state: PersistedGitDiffState): void {
        try {
            const refId = this.sqlite.currentGitRefId();
            // UX-64 Phase 3 (2026-06-09) — write to BOTH the legacy table
            // (id = 1) and the new scoped v2 table. The dual write keeps
            // older code paths reading the legacy slot while the scoped
            // table accumulates per-repo entries that survive concurrent
            // sessions across sibling sub-repos.
            const stateJson = JSON.stringify({
                diffedGraphs: state.diffedGraphs,
                apiIndex: state.apiIndex,
                scopedRepo: state.scopedRepo,
            });
            const scope = state.scopedRepo ?? 'workspace';
            this.sqlite.transaction(() => {
                this.sqlite.run(
                    `INSERT INTO git_diff_sessions (id, base_hash, head_hash, base_label, head_label, git_ref_id, state_json)
                     VALUES (1, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                        base_hash  = excluded.base_hash,
                        head_hash  = excluded.head_hash,
                        base_label = excluded.base_label,
                        head_label = excluded.head_label,
                        git_ref_id = excluded.git_ref_id,
                        state_json = excluded.state_json`,
                    [state.baseHash, state.headHash, state.baseLabel, state.headLabel, refId, stateJson],
                );
                this.sqlite.run(
                    `INSERT INTO git_diff_sessions_v2 (scope, base_hash, head_hash, base_label, head_label, git_ref_id, state_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(scope) DO UPDATE SET
                        base_hash  = excluded.base_hash,
                        head_hash  = excluded.head_hash,
                        base_label = excluded.base_label,
                        head_label = excluded.head_label,
                        git_ref_id = excluded.git_ref_id,
                        state_json = excluded.state_json`,
                    [scope, state.baseHash, state.headHash, state.baseLabel, state.headLabel, refId, stateJson],
                );
            });
            this.sqlite.flush();
        } catch (err: any) {
            this.log(`[GitDiffStore] Failed to save: ${err?.message ?? err}`);
        }
    }

    clear(scope?: string): void {
        try {
            this.sqlite.run(`DELETE FROM git_diff_sessions WHERE id = 1`, []);
            // UX-64 Phase 3 — clear the v2 table too. When `scope` is set,
            // drop only that scope's entry so a per-repo "close diff"
            // doesn't blow away other active sessions.
            if (scope) {
                this.sqlite.run(`DELETE FROM git_diff_sessions_v2 WHERE scope = ?`, [scope]);
            } else {
                this.sqlite.run(`DELETE FROM git_diff_sessions_v2`, []);
            }
            this.sqlite.flush();
        } catch (err: any) {
            this.log(`[GitDiffStore] Failed to clear: ${err?.message ?? err}`);
        }
        // Best-effort cleanup of the legacy file if it lingered.
        try {
            const legacyPath = path.join(this.workspaceRoot, STORAGE_DIR, LEGACY_FILE);
            if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        } catch { /* best-effort */ }
    }

    private rowToState(row: Record<string, any>): PersistedGitDiffState | null {
        try {
            const inner = JSON.parse(String(row.state_json));
            const state: PersistedGitDiffState = {
                baseHash: String(row.base_hash),
                headHash: String(row.head_hash),
                baseLabel: String(row.base_label),
                headLabel: String(row.head_label),
                diffedGraphs: (inner?.diffedGraphs ?? {}) as Record<string, DiagramGraph>,
                apiIndex: (inner?.apiIndex ?? {}) as Record<string, ApiRecord>,
            };
            // UX-64 Phase 3 — optional field; absent on legacy rows.
            if (typeof inner?.scopedRepo === 'string') state.scopedRepo = inner.scopedRepo;
            return state;
        } catch {
            return null;
        }
    }

    private tryReadLegacy(): PersistedGitDiffState | null {
        const legacyPath = path.join(this.workspaceRoot, STORAGE_DIR, LEGACY_FILE);
        if (!fs.existsSync(legacyPath)) return null;
        try {
            const raw = fs.readFileSync(legacyPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && typeof parsed.baseHash === 'string') {
                return parsed as PersistedGitDiffState;
            }
            return null;
        } catch {
            return null;
        }
    }
}
