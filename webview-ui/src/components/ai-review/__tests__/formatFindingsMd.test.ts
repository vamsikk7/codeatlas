/**
 * formatFindingsMd tests (#540)
 */

import { describe, it, expect } from 'vitest';
import { formatFindingsMd } from '../formatFindingsMd';
import type { AiReviewFinding } from '../types';

function mkF(overrides: Partial<AiReviewFinding> = {}): AiReviewFinding {
    return {
        id: 'f1',
        entryPointId: 'GET:/health',
        bindings: [{ graphId: 'file:src/health.ts', targetId: 'h', targetType: 'node', layer: 'file' }],
        severity: 'warning',
        category: 'code-quality',
        title: 'Missing probe',
        body: 'Add /health endpoint.',
        anchor: { filePath: 'src/health.ts', symbol: 'health' },
        status: 'open',
        model: 'm',
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        ...overrides,
    };
}

describe('formatFindingsMd', () => {
    it('returns a placeholder when empty', () => {
        expect(formatFindingsMd([])).toContain('No AI Review findings');
    });

    it('headers count by severity', () => {
        const out = formatFindingsMd([
            mkF({ id: 'e', severity: 'error', title: 'Bad' }),
            mkF({ id: 'w', severity: 'warning', title: 'Meh' }),
        ]);
        expect(out).toContain('AI Review findings — 2 total');
        expect(out).toContain('1 errors');
        expect(out).toContain('1 warnings');
    });

    it('sorts errors first', () => {
        const out = formatFindingsMd([
            mkF({ id: 'a', severity: 'info', title: 'Info finding' }),
            mkF({ id: 'b', severity: 'error', title: 'Error finding' }),
        ]);
        const idxErr = out.indexOf('Error finding');
        const idxInfo = out.indexOf('Info finding');
        expect(idxErr).toBeLessThan(idxInfo);
    });

    it('includes evidence snippet with detected language tag', () => {
        const out = formatFindingsMd([
            mkF({
                anchor: { filePath: 'src/app.ts', symbol: 'main', snippet: 'console.log(secret)' } as any,
            }),
        ]);
        expect(out).toContain('```ts');
        expect(out).toContain('console.log(secret)');
    });

    it('includes baselineRef when present', () => {
        const out = formatFindingsMd([
            mkF({ baselineRef: { kind: 'git', ref: 'abc1234', capturedAt: '2026-05-22T00:00:00Z' } } as any),
        ]);
        expect(out).toContain('Baseline:');
        expect(out).toContain('git:abc1234');
    });
});
