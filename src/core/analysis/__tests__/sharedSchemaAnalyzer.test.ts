/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — sharedSchemaAnalyzer tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { CrossRepoAnalyzerRegistry } from '../../sync/crossRepoAnalyzer';
import { sharedSchemaAnalyzer } from '../sharedSchemaAnalyzer';
import { emptyRepoSummary, type RepoSummary, type SummarySchema } from '../../sync/repoSummary';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssa-test-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    const reg = new CrossRepoAnalyzerRegistry();
    reg.register(sharedSchemaAnalyzer);
    agg.setAnalyzerRegistry(reg);
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function summary(repoId: string, schemas: ReadonlyArray<SummarySchema>): RepoSummary {
    return { ...emptyRepoSummary(repoId), schemas };
}

const pgUser: SummarySchema = { engine: 'postgresql', tableName: 'users', displayName: 'User', source: 'prisma' };
const pgOrder: SummarySchema = { engine: 'postgresql', tableName: 'orders', displayName: 'Order', source: 'prisma' };
const mongoUser: SummarySchema = { engine: 'mongodb', tableName: 'users', displayName: 'User', source: 'mongoose' };

describe('sharedSchemaAnalyzer — same engine + table across repos', () => {
    it('3 repos declare Prisma User → one row with all three consumers', async () => {
        const agg = await makeAggregator();
        agg.applySummary('svc-alpha', summary('svc-alpha', [pgUser]));
        agg.applySummary('svc-beta',  summary('svc-beta',  [pgUser]));
        agg.applySummary('svc-gamma', summary('svc-gamma', [pgUser]));
        const schemas = agg.listSharedSchemas();
        expect(schemas).toHaveLength(1);
        expect(schemas[0].engine).toBe('postgresql');
        expect(schemas[0].tableName).toBe('users');
        expect(schemas[0].consumers).toEqual(['svc-alpha', 'svc-beta', 'svc-gamma']);
        agg.close();
    });

    it('shared User + isolated Order → two rows', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser, pgOrder]));
        agg.applySummary('b', summary('b', [pgUser]));
        const schemas = [...agg.listSharedSchemas()].sort((x, y) => x.tableName.localeCompare(y.tableName));
        expect(schemas.map((s) => s.tableName)).toEqual(['orders', 'users']);
        expect(schemas.find((s) => s.tableName === 'orders')!.consumers).toEqual(['a']);
        expect(schemas.find((s) => s.tableName === 'users')!.consumers).toEqual(['a', 'b']);
        agg.close();
    });
});

describe('sharedSchemaAnalyzer — engine matters', () => {
    it('postgresql:users and mongodb:users are distinct rows', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser]));
        agg.applySummary('b', summary('b', [mongoUser]));
        const schemas = agg.listSharedSchemas();
        expect(schemas).toHaveLength(2);
        const pg = schemas.find((s) => s.engine === 'postgresql');
        const mongo = schemas.find((s) => s.engine === 'mongodb');
        expect(pg!.consumers).toEqual(['a']);
        expect(mongo!.consumers).toEqual(['b']);
        agg.close();
    });

    it('one repo declares both engines for same name → two rows for that repo', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser, mongoUser]));
        const schemas = agg.listSharedSchemas();
        expect(schemas).toHaveLength(2);
        for (const s of schemas) expect(s.consumers).toEqual(['a']);
        agg.close();
    });
});

describe('sharedSchemaAnalyzer — removal & re-apply', () => {
    it('repo drops a schema → consumer removed; singleton row deleted', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser, pgOrder]));
        agg.applySummary('b', summary('b', [pgUser]));
        agg.applySummary('a', summary('a', [pgUser]));   // dropped orders
        const schemas = agg.listSharedSchemas();
        expect(schemas.map((s) => s.tableName)).toEqual(['users']);
        expect(schemas[0].consumers).toEqual(['a', 'b']);
        agg.close();
    });

    it('onRepoRemoved scrubs consumer from every row', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser, pgOrder]));
        agg.applySummary('b', summary('b', [pgUser]));
        sharedSchemaAnalyzer.onRepoRemoved!('a', agg);
        const schemas = agg.listSharedSchemas();
        // orders had only `a` → row deleted; users keeps `b`
        expect(schemas.map((s) => s.tableName)).toEqual(['users']);
        expect(schemas[0].consumers).toEqual(['b']);
        agg.close();
    });

    it('identical re-apply is a no-op', async () => {
        const agg = await makeAggregator();
        agg.applySummary('a', summary('a', [pgUser]));
        const before = JSON.stringify(agg.listSharedSchemas());
        agg.applySummary('a', summary('a', [pgUser]));
        const after = JSON.stringify(agg.listSharedSchemas());
        expect(after).toBe(before);
        agg.close();
    });
});
