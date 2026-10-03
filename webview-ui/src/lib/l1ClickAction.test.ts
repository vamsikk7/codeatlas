/**
 * #836 — L1 service-node click decision table (bucket dead-end + scoped
 * repo threading). Live walkthrough repro, build 116.
 */
import { describe, it, expect } from 'vitest';
import { resolveL1ClickAction } from './l1ClickAction';

describe('resolveL1ClickAction (#836)', () => {
    it('cross-repo neighbour re-scopes the URL (UX-65 preserved)', () => {
        expect(resolveL1ClickAction(
            { label: 'producer', meta: { crossRepoTarget: 'producer' } },
            '#/system-design/consumer',
        )).toEqual({ kind: 'rescope', hash: '#/system-design/producer' });
    });

    it('#836A — AWS bucket node yields an explanatory toast, never a features drill', () => {
        const action = resolveL1ClickAction(
            { label: 'DynamoDB', meta: { awsBucket: 'dynamodb', patternCount: 23, serviceId: 'aws:dynamodb' } },
            '#/system-design',
        );
        expect(action.kind).toBe('bucket-toast');
        expect((action as any).text).toContain('DynamoDB');
        expect((action as any).text).toContain('23');
    });

    it('#836B — scoped URL threads the repo as repoId for colliding service ids', () => {
        expect(resolveL1ClickAction(
            { label: 'main', meta: { serviceId: 'service:main' } },
            '#/system-design/aws-node-typescript-rest-api-with-dynamodb',
        )).toEqual({
            kind: 'open-features',
            serviceId: 'service:main',
            repoId: 'aws-node-typescript-rest-api-with-dynamodb',
        });
    });

    it('#836B — node meta.repoId wins over the URL scope', () => {
        expect(resolveL1ClickAction(
            { label: 'api', meta: { serviceId: 'aaaa1111', repoId: 'aaaa1111' } },
            '#/system-design/some-other-repo',
        )).toEqual({ kind: 'open-features', serviceId: 'aaaa1111', repoId: 'aaaa1111' });
    });

    it('bare workspace L1 (no scope, no repoId) sends no hint — single-repo unchanged', () => {
        expect(resolveL1ClickAction(
            { label: 'main', meta: { serviceId: 'service:main' } },
            '#/system-design',
        )).toEqual({ kind: 'open-features', serviceId: 'service:main' });
    });

    it('URL-encoded scope segments decode before threading', () => {
        const action = resolveL1ClickAction(
            { label: 'svc', meta: { serviceId: 'service:svc' } },
            '#/system-design/my%20repo',
        );
        expect((action as any).repoId).toBe('my repo');
    });
});
