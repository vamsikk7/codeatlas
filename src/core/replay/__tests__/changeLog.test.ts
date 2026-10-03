import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChangeLog, type ChangeLogEntry } from '../changeLog';
import { GitRefProvider } from '../../storage/gitRefProvider';
import { SqliteStore } from '../../storage/sqliteStore';

let tmpDir: string;
let sqlite: SqliteStore;
let log: ChangeLog;

function makeEntry(id: string, fns: string[] = ['testFn']): ChangeLogEntry {
    return {
        id,
        timestamp: new Date().toISOString(),
        filePath: 'src/test.ts',
        changedFunctions: fns,
        newFunctions: [],
        deletedFunctions: [],
        impactSummary: { directImpacts: 1, transitiveImpacts: 2, clustersAffected: 1, servicesAffected: 0 },
        primaryGraphId: `flow:src/test.ts:${fns[0]}`,
    };
}

async function makeSqlite(workspaceRoot: string): Promise<SqliteStore> {
    const provider = new GitRefProvider(workspaceRoot);
    const s = new SqliteStore(workspaceRoot, provider);
    await s.init();
    return s;
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
    fs.mkdirSync(path.join(tmpDir, '.codeatlas'), { recursive: true });
    sqlite = await makeSqlite(tmpDir);
    log = new ChangeLog();
    log.setSqlite(sqlite);
});

afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ChangeLog', () => {
    it('adds and retrieves entries', () => {
        log.add(makeEntry('e1'));
        log.add(makeEntry('e2'));
        expect(log.getAll()).toHaveLength(2);
    });

    it('caps at 500 entries', () => {
        for (let i = 0; i < 510; i++) {
            log.add(makeEntry(`e${i}`));
        }
        expect(log.getAll()).toHaveLength(500);
        // Oldest entries removed
        expect(log.getAll()[0].id).toBe('e10');
    });

    it('getById returns the correct entry', () => {
        log.add(makeEntry('e1', ['foo']));
        log.add(makeEntry('e2', ['bar']));
        expect(log.getById('e2')?.changedFunctions).toEqual(['bar']);
        expect(log.getById('e999')).toBeUndefined();
    });

    it('save and load round-trip across instances', async () => {
        log.add(makeEntry('e1', ['alpha']));
        log.add(makeEntry('e2', ['beta']));
        log.save(tmpDir);
        // Re-open the DB to prove the write made it to disk.
        sqlite.close();
        const sqlite2 = await makeSqlite(tmpDir);
        try {
            const loaded = new ChangeLog();
            loaded.setSqlite(sqlite2);
            loaded.load(tmpDir);
            expect(loaded.getAll()).toHaveLength(2);
            expect(loaded.getById('e1')?.changedFunctions).toEqual(['alpha']);
        } finally {
            sqlite2.close();
            sqlite = await makeSqlite(tmpDir); // restore for afterEach close()
        }
    });

    it('clear removes all entries (in-memory + DB)', () => {
        log.add(makeEntry('e1'));
        log.save(tmpDir);
        log.clear();
        expect(log.getAll()).toHaveLength(0);
        const n = Number(sqlite.get('SELECT COUNT(*) AS n FROM change_log')?.n);
        expect(n).toBe(0);
    });

    it('load handles missing legacy file gracefully', () => {
        const fresh = new ChangeLog();
        fresh.setSqlite(sqlite);
        fresh.load(tmpDir);
        expect(fresh.getAll()).toHaveLength(0);
    });

    it('imports a legacy change-log.json on first load when DB is empty', () => {
        const legacyEntries = [makeEntry('legacy1', ['x']), makeEntry('legacy2', ['y'])];
        fs.writeFileSync(path.join(tmpDir, '.codeatlas', 'change-log.json'), JSON.stringify(legacyEntries));
        const fresh = new ChangeLog();
        fresh.setSqlite(sqlite);
        fresh.load(tmpDir);
        expect(fresh.getAll()).toHaveLength(2);
        expect(fresh.getById('legacy1')?.changedFunctions).toEqual(['x']);
    });
});
