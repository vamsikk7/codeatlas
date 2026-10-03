import { describe, it, expect } from 'vitest';
import { inferDomainPhraseForCluster } from '../inferDomainPhraseForCluster';
import type { DomainCluster } from '../../graph/graphTypes';

function dom(over: Partial<DomainCluster>): DomainCluster {
    return {
        id: over.id ?? 'domain:test',
        name: over.name ?? 'Test domain',
        verb: over.verb ?? 'test',
        routes: over.routes ?? [],
        files: over.files ?? [],
        confidence: over.confidence ?? 0.5,
        ...over,
    } as DomainCluster;
}

describe('inferDomainPhraseForCluster — UX-8', () => {
    it('returns the domain phrase whose files overlap the cluster the most', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': dom({ id: 'domain:auth', name: 'Authenticate users', files: ['src/auth/login.ts', 'src/auth/token.ts'] }),
            'domain:profile': dom({ id: 'domain:profile', name: 'Manage profiles', files: ['src/profile/edit.ts'] }),
        };
        const out = inferDomainPhraseForCluster(['src/auth/login.ts', 'src/auth/token.ts'], domains);
        expect(out).toBe('Authenticate users');
    });

    it('returns null when no domain claims any of the cluster\'s files', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': dom({ id: 'domain:auth', name: 'Authenticate users', files: ['src/auth/login.ts'] }),
        };
        const out = inferDomainPhraseForCluster(['src/orphan/util.ts'], domains);
        expect(out).toBeNull();
    });

    it('returns null when domains map is undefined/null/empty', () => {
        expect(inferDomainPhraseForCluster(['src/a.ts'], null)).toBeNull();
        expect(inferDomainPhraseForCluster(['src/a.ts'], undefined)).toBeNull();
        expect(inferDomainPhraseForCluster(['src/a.ts'], {})).toBeNull();
    });

    it('returns null when cluster has no files', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': dom({ id: 'domain:auth', name: 'Authenticate users', files: ['src/auth/login.ts'] }),
        };
        expect(inferDomainPhraseForCluster([], domains)).toBeNull();
    });

    it('breaks overlap ties by domain confidence (higher wins)', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:low': dom({ id: 'domain:low', name: 'Low conf', files: ['src/x.ts'], confidence: 0.4 }),
            'domain:hi': dom({ id: 'domain:hi', name: 'High conf', files: ['src/x.ts'], confidence: 0.9 }),
        };
        const out = inferDomainPhraseForCluster(['src/x.ts'], domains);
        expect(out).toBe('High conf');
    });

    it('skips malformed domain entries gracefully (no files array)', () => {
        const domains: Record<string, any> = {
            'domain:broken': { id: 'domain:broken', name: 'Broken', verb: 'x', confidence: 0.5 }, // no files array
            'domain:good': dom({ id: 'domain:good', name: 'Good', files: ['src/a.ts'], confidence: 0.5 }),
        };
        const out = inferDomainPhraseForCluster(['src/a.ts'], domains);
        expect(out).toBe('Good');
    });
});
