import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { workingDiffersFromBaseline } from '../replayWorkingChanges';
import type { Snapshot } from '../../core/graph/graphTypes';

function hashOf(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}

function makeSnap(files: Record<string, string>, opts?: { dropContent?: boolean }): Snapshot {
    const out: any = { files: {}, graphs: {}, apiIndex: {}, services: {}, clusters: {}, callGraph: { edges: [] } };
    for (const [p, content] of Object.entries(files)) {
        out.files[p] = {
            path: p,
            hash: hashOf(content),
            mtime: 0,
            content: opts?.dropContent ? undefined : content,
            symbols: { imports: [], variables: [], functions: [], classes: [], calls: [] },
        };
    }
    return out as Snapshot;
}

describe('workingDiffersFromBaseline', () => {
    it('returns false when working files match baseline byte-for-byte', () => {
        const b = makeSnap({ 'src/a.ts': 'export const x = 1;' });
        const w = makeSnap({ 'src/a.ts': 'export const x = 1;' });
        expect(workingDiffersFromBaseline(b, w)).toBe(false);
    });

    it('returns true when a file has changed content', () => {
        const b = makeSnap({ 'src/a.ts': 'export const x = 1;' });
        const w = makeSnap({ 'src/a.ts': 'export const x = 2;' });
        expect(workingDiffersFromBaseline(b, w)).toBe(true);
    });

    it('returns true when a file is added in working', () => {
        const b = makeSnap({});
        const w = makeSnap({ 'src/new.ts': 'x' });
        expect(workingDiffersFromBaseline(b, w)).toBe(true);
    });

    it('returns true when a file is deleted from working', () => {
        const b = makeSnap({ 'src/old.ts': 'x' });
        const w = makeSnap({});
        expect(workingDiffersFromBaseline(b, w)).toBe(true);
    });

    it('returns true even when FileRecord.content has been dropped (lazy-content) but hashes differ (regression for "No working changes to replay" bug)', () => {
        // Reproduces the live failure: after the first persist, snapshotStore
        // drops FileRecord.content from memory. Comparing `.content` returned
        // both-undefined and the helper falsely reported "no changes". Hashes
        // remain authoritative.
        const b = makeSnap({ 'src/a.ts': 'export const x = 1;' }, { dropContent: true });
        const w = makeSnap({ 'src/a.ts': 'export const x = 2;' }, { dropContent: true });
        expect(b.files['src/a.ts'].content).toBeUndefined();
        expect(w.files['src/a.ts'].content).toBeUndefined();
        expect(b.files['src/a.ts'].hash).not.toBe(w.files['src/a.ts'].hash);
        expect(workingDiffersFromBaseline(b, w)).toBe(true);
    });

    it('returns false for two empty snapshots', () => {
        expect(workingDiffersFromBaseline(makeSnap({}), makeSnap({}))).toBe(false);
    });
});
