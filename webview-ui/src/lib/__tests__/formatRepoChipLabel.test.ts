import { describe, it, expect } from 'vitest';
import { formatRepoChipLabel, formatRepoChipTooltip } from '../formatRepoChipLabel';

describe('formatRepoChipLabel — UX-19', () => {
    it('prefers repoName over rootPath / repoId', () => {
        expect(formatRepoChipLabel({ repoName: 'api', rootPath: 'services/api', repoId: 'dc2ef130f90896f2' })).toBe('api');
    });

    it('falls back to rootPath when repoName is missing', () => {
        expect(formatRepoChipLabel({ rootPath: 'services/api', repoId: 'dc2ef130f90896f2' })).toBe('services/api');
    });

    it('abbreviates long hex repoIds when nothing friendlier is available', () => {
        expect(formatRepoChipLabel({ repoId: 'dc2ef130f90896f2' })).toBe('dc2ef1…');
    });

    it('leaves short / human ids alone (no abbreviation)', () => {
        expect(formatRepoChipLabel({ repoId: 'api' })).toBe('api');
        expect(formatRepoChipLabel({ repoId: 'web' })).toBe('web');
    });

    it('returns empty string on null/empty meta', () => {
        expect(formatRepoChipLabel(null)).toBe('');
        expect(formatRepoChipLabel(undefined)).toBe('');
        expect(formatRepoChipLabel({})).toBe('');
        expect(formatRepoChipLabel({ repoId: '', rootPath: '', repoName: '' })).toBe('');
    });

    it('ignores whitespace-only entries', () => {
        expect(formatRepoChipLabel({ repoName: '   ', rootPath: 'services/api', repoId: 'x' })).toBe('services/api');
    });
});

describe('formatRepoChipTooltip — UX-19', () => {
    it('includes both rootPath and full repoId when both are present', () => {
        expect(formatRepoChipTooltip({ repoId: 'dc2ef130f90896f2', rootPath: 'services/api' }))
            .toBe('Owning repo: services/api (dc2ef130f90896f2)');
    });

    it('falls back to repoId alone when rootPath is missing', () => {
        expect(formatRepoChipTooltip({ repoId: 'dc2ef130f90896f2' }))
            .toBe('Owning repo: dc2ef130f90896f2');
    });

    it('handles null', () => {
        expect(formatRepoChipTooltip(null)).toBe('');
    });
});
