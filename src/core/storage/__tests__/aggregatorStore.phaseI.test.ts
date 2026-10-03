/**
 * ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — dev_base_url + api_testing_chains CRUD tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../aggregatorStore';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phaseI-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('AggregatorStore — dev_base_url', () => {
    it('getDevBaseUrl on unknown repo returns empty string', async () => {
        const agg = await makeAggregator();
        expect(agg.getDevBaseUrl('does-not-exist')).toBe('');
        agg.close();
    });

    it('setDevBaseUrl + getDevBaseUrl round-trip', async () => {
        const agg = await makeAggregator();
        agg.setDevBaseUrl('svc-alpha', 'http://localhost:3000');
        expect(agg.getDevBaseUrl('svc-alpha')).toBe('http://localhost:3000');
        agg.close();
    });

    it('setDevBaseUrl is upsert — second write replaces first', async () => {
        const agg = await makeAggregator();
        agg.setDevBaseUrl('svc-alpha', 'http://old:3000');
        agg.setDevBaseUrl('svc-alpha', 'http://new:4000');
        expect(agg.getDevBaseUrl('svc-alpha')).toBe('http://new:4000');
        agg.close();
    });

    it('setDevBaseUrl("") clears the value to empty string', async () => {
        const agg = await makeAggregator();
        agg.setDevBaseUrl('svc-alpha', 'http://localhost:3000');
        agg.setDevBaseUrl('svc-alpha', '');
        expect(agg.getDevBaseUrl('svc-alpha')).toBe('');
        agg.close();
    });

    it('per-repo isolation — setting one repo does not affect another', async () => {
        const agg = await makeAggregator();
        agg.setDevBaseUrl('svc-alpha', 'http://alpha:3000');
        agg.setDevBaseUrl('svc-beta', 'http://beta:3001');
        expect(agg.getDevBaseUrl('svc-alpha')).toBe('http://alpha:3000');
        expect(agg.getDevBaseUrl('svc-beta')).toBe('http://beta:3001');
        agg.close();
    });
});

describe('AggregatorStore — api_testing_chains', () => {
    it('list returns empty by default', async () => {
        const agg = await makeAggregator();
        expect(agg.listApiTestingChains()).toEqual([]);
        agg.close();
    });

    it('save + get round-trip', async () => {
        const agg = await makeAggregator();
        agg.saveApiTestingChain({
            chainId: 'chain-1',
            name: 'Login → Fetch profile',
            stepsJson: JSON.stringify([
                { method: 'POST', apiId: 'auth.login', repoId: 'svc-alpha' },
                { method: 'GET', apiId: 'users.me', repoId: 'svc-beta' },
            ]),
            envText: 'BASE_URL=http://localhost:3000',
            updatedAt: 1700000000000,
        });
        const got = agg.getApiTestingChain('chain-1');
        expect(got).toBeDefined();
        expect(got!.name).toBe('Login → Fetch profile');
        expect(JSON.parse(got!.stepsJson)).toHaveLength(2);
        expect(got!.envText).toBe('BASE_URL=http://localhost:3000');
        agg.close();
    });

    it('save is upsert — same chainId replaces', async () => {
        const agg = await makeAggregator();
        agg.saveApiTestingChain({
            chainId: 'c', name: 'v1', stepsJson: '[]', envText: '', updatedAt: 1000,
        });
        agg.saveApiTestingChain({
            chainId: 'c', name: 'v2', stepsJson: '[{}]', envText: 'X=1', updatedAt: 2000,
        });
        const got = agg.getApiTestingChain('c');
        expect(got!.name).toBe('v2');
        expect(got!.envText).toBe('X=1');
        agg.close();
    });

    it('list orders by updated_at DESC', async () => {
        const agg = await makeAggregator();
        agg.saveApiTestingChain({ chainId: 'a', name: 'old', stepsJson: '[]', envText: '', updatedAt: 1000 });
        agg.saveApiTestingChain({ chainId: 'b', name: 'new', stepsJson: '[]', envText: '', updatedAt: 3000 });
        agg.saveApiTestingChain({ chainId: 'c', name: 'mid', stepsJson: '[]', envText: '', updatedAt: 2000 });
        const list = agg.listApiTestingChains();
        expect(list.map((c) => c.chainId)).toEqual(['b', 'c', 'a']);
        agg.close();
    });

    it('delete removes the row', async () => {
        const agg = await makeAggregator();
        agg.saveApiTestingChain({ chainId: 'c', name: 'x', stepsJson: '[]', envText: '', updatedAt: 1 });
        agg.deleteApiTestingChain('c');
        expect(agg.getApiTestingChain('c')).toBeUndefined();
        expect(agg.listApiTestingChains()).toEqual([]);
        agg.close();
    });

    it('delete on unknown chainId is no-op', async () => {
        const agg = await makeAggregator();
        agg.deleteApiTestingChain('nope');
        expect(agg.listApiTestingChains()).toEqual([]);
        agg.close();
    });

    it('survives close + reopen (persistence)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-phaseI-persist-'));
        tmpDirs.push(dir);
        const first = new AggregatorStore(dir);
        await first.init();
        first.setDevBaseUrl('svc-alpha', 'http://example:3000');
        first.saveApiTestingChain({
            chainId: 'c', name: 'login chain', stepsJson: '[]', envText: '', updatedAt: 1700000000000,
        });
        first.save();
        first.close();

        const second = new AggregatorStore(dir);
        await second.init();
        expect(second.getDevBaseUrl('svc-alpha')).toBe('http://example:3000');
        const chain = second.getApiTestingChain('c');
        expect(chain).toBeDefined();
        expect(chain!.name).toBe('login chain');
        second.close();
    });
});
