/**
 * navigationHandlers.fileGraphDiff.test.ts
 *
 * Regression: navigating to an L4 file diagram (e.g. by clicking a sequence
 * participant) was clobbering the file:graph's diff annotations because
 * `buildFileGraphForPath` read `baselineFile.content` directly. `.content`
 * is dropped post-save (lazy-content fragility), so the build call became
 * `buildFileGraph(code, path, undefined)` and every node ended up
 * `unchanged`. The fix is to fall back to the SQLite-backed
 * `getFileContent('baseline', path)` accessor.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-l4-regress-'));

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: TMP_ROOT } }],
        getConfiguration: () => ({ get: () => undefined }),
    },
    window: { showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
    env: { machineId: 'test', sessionId: 'test', appName: 'VS Code', uriScheme: 'vscode' },
    version: '1.0.0',
}));

const BASELINE_CONTENT = `export const createUser = async (input: any) => {
  const hashedPassword = await bcrypt.hash(input.password, 10);
  return { id: 1, password: hashedPassword };
};

export const getCurrentUser = async (id: number) => {
  console.log('[probe] line 1');
  console.log('[probe] line 2');
  return { id };
};

export const updateUser = async (input: any, id: number) => {
  const hashedPassword = await bcrypt.hash(input.password, 10);
  return { id, password: hashedPassword };
};
`;

// Redacted form that snapshotStore persists — same shape, redacted body
// (this mimics what getFileContent('baseline', path) returns).
const REDACTED_BASELINE_CONTENT = BASELINE_CONTENT.replace(/hashedPassword/g, '"[REDACTED]"');

const WORKING_CONTENT = `export const createUser = async (input: any) => {
  const hashedPassword = await bcrypt.hash(input.password, 10);
  return { id: 1, password: hashedPassword };
};

export const getCurrentUser = async (id: number) => {
  return { id };
};

export const updateUser = async (input: any, id: number) => {
  const hashedPassword = await bcrypt.hash(input.password, 10);
  return { id, password: hashedPassword };
};
`;

const REL_PATH = 'src/auth.ts';
const ABS_PATH = path.join(TMP_ROOT, REL_PATH);

beforeAll(() => {
    fs.mkdirSync(path.dirname(ABS_PATH), { recursive: true });
    fs.writeFileSync(ABS_PATH, WORKING_CONTENT, 'utf-8');
});

afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('buildFileGraphForPath — L4 cascade regression', () => {
    it('emits modified diff annotations when baselineFile.content is undefined (lazy-content) but getFileContent returns baseline', async () => {
        const { buildFileGraphForPath } = await import('../navigationHandlers');
        const { collectTopLevelEntities } = await import('../../core/parser/symbolExtractor');

        // Symbols captured pre-redaction (authoritative, un-redacted bodies)
        const baselineSymbols = collectTopLevelEntities(BASELINE_CONTENT, REL_PATH);
        const baselineFileRecord = {
            path: REL_PATH,
            hash: 'baseline-hash',
            mtime: 0,
            content: undefined,
            symbols: {
                functions: baselineSymbols.entities
                    .filter(e => e.kind === 'function')
                    .map((e: any) => ({
                        name: e.name,
                        kind: e.kind,
                        span: { start: e.node?.start ?? 0, end: e.node?.end ?? 0 },
                        signature: e.signature,
                        bodyText: e.bodyText,
                        stableKey: e.key,
                    })),
                variables: [],
                imports: [],
            },
        };

        const snapshotStore: any = {
            getBaseline: () => ({ files: { [REL_PATH]: baselineFileRecord }, apiIndex: {}, graphs: {} }),
            getWorking: () => ({ files: {}, apiIndex: {}, graphs: {} }),
            getFileContent: (kind: string, fp: string) => {
                if (kind === 'baseline' && fp === REL_PATH) return BASELINE_CONTENT;
                return undefined;
            },
            updateWorkingGraph: vi.fn(),
        };

        const ctx: any = { snapshotStore, log: vi.fn(), notifyBrowser: vi.fn() };

        const graph = await buildFileGraphForPath(ctx, REL_PATH);
        expect(graph).toBeDefined();

        const functionNodes = (graph!.nodes ?? []).filter(n => n.type === 'function');
        const byLabel: Record<string, string> = {};
        for (const n of functionNodes) byLabel[(n.label as string) ?? ''] = n.diff ?? 'unchanged';

        expect(byLabel.getCurrentUser).toBe('modified');
        expect(byLabel.createUser).toBe('unchanged');
        expect(byLabel.updateUser).toBe('unchanged');
    });

    it('avoids redaction-driven false positives when baseline content is redacted (regression for createUser/updateUser bug)', async () => {
        const { buildFileGraphForPath } = await import('../navigationHandlers');
        const { collectTopLevelEntities } = await import('../../core/parser/symbolExtractor');

        // Symbols captured pre-redaction — these have the original
        // un-redacted bodyText, which is the authoritative source.
        const baselineSymbols = collectTopLevelEntities(BASELINE_CONTENT, REL_PATH);
        const baselineFileRecord = {
            path: REL_PATH,
            hash: 'baseline-hash',
            mtime: 0,
            content: undefined,
            symbols: {
                functions: baselineSymbols.entities
                    .filter(e => e.kind === 'function')
                    .map((e: any) => ({
                        name: e.name,
                        kind: e.kind,
                        span: { start: e.node?.start ?? 0, end: e.node?.end ?? 0 },
                        signature: e.signature,
                        bodyText: e.bodyText,
                        stableKey: e.key,
                    })),
                variables: [],
                imports: [],
            },
        };

        // Storage returns REDACTED baseline content. Without the
        // recomputeFileGraphDiffFromAuthoritativeSymbols override,
        // re-parsing this would yield bodyText with `"[REDACTED]"`
        // for createUser and updateUser, while the fresh working
        // parse has `hashedPassword` — diff mode falsely marks them.
        const snapshotStore: any = {
            getBaseline: () => ({ files: { [REL_PATH]: baselineFileRecord }, apiIndex: {}, graphs: {} }),
            getWorking: () => ({ files: {}, apiIndex: {}, graphs: {} }),
            getFileContent: (kind: string, fp: string) => {
                if (kind === 'baseline' && fp === REL_PATH) return REDACTED_BASELINE_CONTENT;
                return undefined;
            },
            updateWorkingGraph: vi.fn(),
        };

        const ctx: any = { snapshotStore, log: vi.fn(), notifyBrowser: vi.fn() };

        const graph = await buildFileGraphForPath(ctx, REL_PATH);
        expect(graph).toBeDefined();

        const functionNodes = (graph!.nodes ?? []).filter(n => n.type === 'function');
        const byLabel: Record<string, string> = {};
        for (const n of functionNodes) byLabel[(n.label as string) ?? ''] = n.diff ?? 'unchanged';

        // Only getCurrentUser actually changed — createUser/updateUser
        // must NOT be marked modified despite the redaction artifact.
        expect(byLabel.getCurrentUser).toBe('modified');
        expect(byLabel.createUser).toBe('unchanged');
        expect(byLabel.updateUser).toBe('unchanged');

        // Section label should reflect the corrected count.
        const section = (graph!.nodes ?? []).find(n => n.type === 'section' && (n.label ?? '').startsWith('Functions'));
        expect(section?.label).toBe('Functions (1 changed + 2)');
    });

    it('falls back gracefully when baseline has no record for the path (every node unchanged is correct then)', async () => {
        const { buildFileGraphForPath } = await import('../navigationHandlers');

        const snapshotStore: any = {
            getBaseline: () => ({ files: {}, apiIndex: {}, graphs: {} }),
            getWorking: () => ({ files: {}, apiIndex: {}, graphs: {} }),
            getFileContent: vi.fn(),
            updateWorkingGraph: vi.fn(),
        };

        const ctx: any = { snapshotStore, log: vi.fn(), notifyBrowser: vi.fn() };

        const graph = await buildFileGraphForPath(ctx, REL_PATH);
        expect(graph).toBeDefined();
        expect(snapshotStore.getFileContent).not.toHaveBeenCalled();
    });
});
