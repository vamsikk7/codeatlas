/**
 * changeLog.ts
 *
 * Records file change events with function-level detail and impact summaries.
 * Persisted to the consolidated SQLite store (`change_log` table) since #349.
 * The legacy `.codeatlas/change-log.json` is auto-imported on first load if
 * present (and the DB has no entries yet).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SqliteStore } from '../storage/sqliteStore';

export interface ChangeDetail {
    filePath: string;
    changedFunctions: string[];
    newFunctions: string[];
    deletedFunctions: string[];
    updatedGraphIds: string[];
}

export interface ChangeLogEntry {
    id: string;
    timestamp: string;
    filePath: string;
    changedFunctions: string[];
    newFunctions: string[];
    deletedFunctions: string[];
    impactSummary: {
        directImpacts: number;
        transitiveImpacts: number;
        clustersAffected: number;
        servicesAffected: number;
    };
    primaryGraphId: string;
}

const MAX_ENTRIES = 500;
const LEGACY_FILE = 'change-log.json';

/**
 * In-memory ring buffer (cap MAX_ENTRIES) backed by SQLite for persistence.
 * The DB is the source of truth; in-memory state is just a hot cache for
 * quick reads from handlers.
 */
export class ChangeLog {
    private entries: ChangeLogEntry[] = [];
    private sqlite: SqliteStore | null = null;
    private hydrated: boolean = false;

    /** Wire up the persistence backend. Must be called before `add` / `save`. */
    setSqlite(sqlite: SqliteStore): void {
        this.sqlite = sqlite;
    }

    add(entry: ChangeLogEntry): void {
        this.ensureHydrated();
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries = this.entries.slice(-MAX_ENTRIES);
        }
    }

    getAll(): ChangeLogEntry[] {
        this.ensureHydrated();
        return [...this.entries];
    }

    getById(id: string): ChangeLogEntry | undefined {
        this.ensureHydrated();
        return this.entries.find(e => e.id === id);
    }

    /** In-memory + persistent clear. */
    clear(): void {
        this.entries = [];
        if (this.sqlite) {
            try {
                this.sqlite.run(`DELETE FROM change_log`, []);
                this.sqlite.flush();
            } catch { /* best-effort */ }
        }
    }

    /**
     * Persist the in-memory entries to SQLite. workspaceRoot is retained
     * for legacy-file cleanup only — actual writes go through `this.sqlite`.
     */
    save(workspaceRoot: string): void {
        if (!this.sqlite) return;
        try {
            const refId = this.sqlite.currentGitRefId();
            this.sqlite.transaction(() => {
                this.sqlite!.run(`DELETE FROM change_log`, []);
                for (const entry of this.entries) {
                    const ts = Date.parse(entry.timestamp);
                    this.sqlite!.run(
                        `INSERT INTO change_log (entry_id, git_ref_id, timestamp, payload_json) VALUES (?, ?, ?, ?)`,
                        [entry.id, refId, Number.isFinite(ts) ? ts : Date.now(), JSON.stringify(entry)],
                    );
                }
            });
            this.sqlite.flush();
        } catch {
            /* best-effort persistence */
        }
        // Best-effort delete of any lingering legacy file.
        try {
            const legacyPath = path.join(workspaceRoot, '.codeatlas', LEGACY_FILE);
            if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        } catch { /* best-effort */ }
    }

    load(workspaceRoot: string): void {
        if (!this.sqlite) return;
        try {
            const rows = this.sqlite.all(`SELECT payload_json FROM change_log ORDER BY timestamp ASC`);
            this.entries = [];
            for (const row of rows) {
                try { this.entries.push(JSON.parse(String(row.payload_json)) as ChangeLogEntry); } catch { /* skip */ }
            }
            this.entries = this.entries.slice(-MAX_ENTRIES);
            if (this.entries.length === 0) this.importLegacy(workspaceRoot);
            this.hydrated = true;
        } catch {
            // SqliteStore.init() may not have run yet (extension activate
            // calls load() before awaiting snapshotStore.load()). That's
            // fine — keep `hydrated=false` so ensureHydrated() retries
            // on first access once the DB is ready.
            this.entries = [];
        }
    }

    private ensureHydrated(): void {
        if (this.hydrated || !this.sqlite) return;
        // We don't know the workspace root here; fall back to skipping the legacy
        // import (it's already covered by explicit load() calls in extension.ts).
        try {
            const rows = this.sqlite.all(`SELECT payload_json FROM change_log ORDER BY timestamp ASC`);
            this.entries = [];
            for (const row of rows) {
                try { this.entries.push(JSON.parse(String(row.payload_json)) as ChangeLogEntry); } catch { /* skip */ }
            }
            this.entries = this.entries.slice(-MAX_ENTRIES);
            this.hydrated = true;
        } catch {
            this.hydrated = true;
        }
    }

    private importLegacy(workspaceRoot: string): void {
        const filePath = path.join(workspaceRoot, '.codeatlas', LEGACY_FILE);
        if (!fs.existsSync(filePath)) return;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                this.entries = parsed.slice(-MAX_ENTRIES);
                // Persist what we just imported so future loads skip the JSON.
                this.save(workspaceRoot);
            }
        } catch {
            this.entries = [];
        }
    }
}
