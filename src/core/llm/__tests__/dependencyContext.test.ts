import { describe, it, expect } from 'vitest';
import { buildDependentsForFiles, type DependencyStoreLike } from '../dependencyContext';
import { WorkspaceCallGraph } from '../../graph/callGraphResolver';

// --- fixture corpus -------------------------------------------------------
const OAUTH = `export function parseRefreshTokenResponse(res) { return res; }\nexport class CalendarService {}\n`;
const SYNC = `import { parseRefreshTokenResponse } from './oauth';\nexport function refreshOAuthTokens() { return parseRefreshTokenResponse(fetch()); }\n`;
const LARK = `export class LarkService { createEvent(e) {} }\n`;
const OFFICE = `export class Office365Service { createEvent(e) {} }\n`;
const TEST = `import { parseRefreshTokenResponse } from '../oauth';\ntest('x', () => { parseRefreshTokenResponse({}); });\n`;

function makeStore(): DependencyStoreLike {
    const files: Record<string, any> = {
        'src/lib/oauth.ts': {
            symbols: { functions: [
                { name: 'parseRefreshTokenResponse', kind: 'function', span: { start: 0, end: 60 }, signature: 'parseRefreshTokenResponse(res)', bodyText: '' },
                { name: 'CalendarService', kind: 'class', span: { start: 62, end: 92 }, signature: 'class CalendarService', bodyText: '' },
            ] },
        },
        'src/lib/sync.ts': {
            symbols: { functions: [
                { name: 'refreshOAuthTokens', kind: 'function', span: { start: 53, end: SYNC.length }, signature: 'refreshOAuthTokens()', bodyText: '' },
            ] },
        },
        'src/lib/apps/lark.ts': {
            symbols: { functions: [
                { name: 'LarkService', kind: 'class', span: { start: 0, end: LARK.length }, signature: 'class LarkService', bodyText: '', implementsInterfaces: ['CalendarService'] },
            ] },
        },
        'src/lib/apps/office365.ts': {
            symbols: { functions: [
                { name: 'Office365Service', kind: 'class', span: { start: 0, end: OFFICE.length }, signature: 'class Office365Service', bodyText: '', implementsInterfaces: ['CalendarService'] },
            ] },
        },
        'src/lib/__tests__/oauth.test.ts': { symbols: { functions: [] } },
    };
    const content: Record<string, string> = {
        'src/lib/oauth.ts': OAUTH,
        'src/lib/sync.ts': SYNC,
        'src/lib/apps/lark.ts': LARK,
        'src/lib/apps/office365.ts': OFFICE,
        'src/lib/__tests__/oauth.test.ts': TEST,
    };
    const cg = new WorkspaceCallGraph();
    cg.ensureNode('src/lib/oauth.ts', 'parseRefreshTokenResponse');
    cg.ensureNode('src/lib/sync.ts', 'refreshOAuthTokens');
    cg.addEdge(
        WorkspaceCallGraph.makeKey('src/lib/sync.ts', 'refreshOAuthTokens'),
        WorkspaceCallGraph.makeKey('src/lib/oauth.ts', 'parseRefreshTokenResponse'),
    );
    return {
        getWorking: () => ({ files, callGraph: cg.serialize() }),
        getFileContent: (_k, fp) => content[fp],
    };
}

describe('#946 dependencyContext.buildDependentsForFiles', () => {
    it('attaches cross-file callers of a changed symbol', () => {
        const out = buildDependentsForFiles(makeStore(), ['src/lib/oauth.ts']);
        expect(out).toHaveLength(1);
        const caller = out[0].dependents.find((d) => d.relation === 'caller');
        expect(caller).toBeDefined();
        expect(caller!.file).toBe('src/lib/sync.ts');
        expect(caller!.symbol).toBe('refreshOAuthTokens');
        expect(caller!.snippet).toContain('refreshOAuthTokens');
    });

    it('attaches interface implementers of a changed class/interface', () => {
        const out = buildDependentsForFiles(makeStore(), ['src/lib/oauth.ts']);
        const impls = out[0].dependents.filter((d) => d.relation === 'implementer').map((d) => d.symbol).sort();
        expect(impls).toEqual(['LarkService', 'Office365Service']);
        // implementer snippets come first (highest contract signal)
        expect(out[0].dependents[0].relation).toBe('implementer');
    });

    it('attaches test files referencing the changed file', () => {
        const out = buildDependentsForFiles(makeStore(), ['src/lib/oauth.ts']);
        const t = out[0].dependents.find((d) => d.relation === 'test');
        expect(t).toBeDefined();
        expect(t!.file).toBe('src/lib/__tests__/oauth.test.ts');
    });

    it('omits files with no cross-file dependents', () => {
        const store = makeStore();
        // a changed file nobody depends on
        (store.getWorking() as any).files['src/lib/lonely.ts'] = { symbols: { functions: [{ name: 'lonelyFn', kind: 'function', span: { start: 0, end: 5 }, signature: '', bodyText: '' }] } };
        const out = buildDependentsForFiles(store, ['src/lib/lonely.ts']);
        expect(out).toHaveLength(0);
    });

    it('caps dependents per file and bounds snippet size', () => {
        const out = buildDependentsForFiles(makeStore(), ['src/lib/oauth.ts'], { maxPerFile: 2 });
        expect(out[0].dependents.length).toBeLessThanOrEqual(2);
        for (const d of out[0].dependents) expect(d.snippet.length).toBeLessThanOrEqual(720);
    });

    it('degrades gracefully with no call graph (implementers + tests still found)', () => {
        const store = makeStore();
        const orig = store.getWorking;
        store.getWorking = () => { const w = orig(); return { files: (w as any).files }; }; // drop callGraph
        const out = buildDependentsForFiles(store, ['src/lib/oauth.ts']);
        expect(out).toHaveLength(1);
        expect(out[0].dependents.some((d) => d.relation === 'implementer')).toBe(true);
        expect(out[0].dependents.some((d) => d.relation === 'caller')).toBe(false);
    });
});
