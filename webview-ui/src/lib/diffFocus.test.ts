/**
 * diffFocus.test.ts — pure logic for the L2 api-list diff-focus (change
 * highlighting): counts, the Changed/+/−/~ filter, changed-first ordering,
 * the auto-expand gate, and the jump-stepper ordering. Shared by
 * FeatureApiListView (feature-grouped) and ApiListPanel (method tabs + search).
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeDiff,
    isChanged,
    computeChangeCounts,
    apiMatchesChangeFilter,
    changeRank,
    groupHasChanges,
    orderedChangedIds,
    type ChangeFilter,
} from './diffFocus';

const items = (diffs: (string | undefined)[]) => diffs.map((diff, i) => ({ id: `n${i}`, diff }));

describe('normalizeDiff / isChanged', () => {
    it('coerces unknown/undefined/null/"unchanged" to "unchanged"', () => {
        expect(normalizeDiff(undefined)).toBe('unchanged');
        expect(normalizeDiff(null)).toBe('unchanged');
        expect(normalizeDiff('unchanged')).toBe('unchanged');
        expect(normalizeDiff('weird')).toBe('unchanged');
    });
    it('passes through the three change kinds', () => {
        expect(normalizeDiff('added')).toBe('added');
        expect(normalizeDiff('deleted')).toBe('deleted');
        expect(normalizeDiff('modified')).toBe('modified');
    });
    it('isChanged is true only for add/delete/modify', () => {
        expect(isChanged('added')).toBe(true);
        expect(isChanged('deleted')).toBe(true);
        expect(isChanged('modified')).toBe(true);
        expect(isChanged('unchanged')).toBe(false);
        expect(isChanged(undefined)).toBe(false);
    });
});

describe('computeChangeCounts', () => {
    it('counts each kind + a combined changed + total', () => {
        const c = computeChangeCounts(items(['added', 'added', 'deleted', 'modified', 'unchanged', undefined]));
        expect(c).toEqual({ added: 2, deleted: 1, modified: 1, changed: 4, total: 6 });
    });
    it('all-unchanged → changed 0 (the diff-focus bar is hidden on this)', () => {
        const c = computeChangeCounts(items(['unchanged', undefined, 'unchanged']));
        expect(c.changed).toBe(0);
        expect(c.total).toBe(3);
    });
    it('empty list → all zeros', () => {
        expect(computeChangeCounts([])).toEqual({ added: 0, deleted: 0, modified: 0, changed: 0, total: 0 });
    });
});

describe('apiMatchesChangeFilter', () => {
    const cases: Array<[ChangeFilter, string | undefined, boolean]> = [
        ['all', 'unchanged', true], ['all', 'added', true], ['all', undefined, true],
        ['changed', 'added', true], ['changed', 'deleted', true], ['changed', 'modified', true],
        ['changed', 'unchanged', false], ['changed', undefined, false],
        ['added', 'added', true], ['added', 'modified', false], ['added', 'unchanged', false],
        ['deleted', 'deleted', true], ['deleted', 'added', false],
        ['modified', 'modified', true], ['modified', 'deleted', false],
    ];
    it.each(cases)('filter=%s diff=%s → %s', (filter, diff, expected) => {
        expect(apiMatchesChangeFilter(diff, filter)).toBe(expected);
    });
});

describe('changeRank (changed-first ordering)', () => {
    it('ranks added < modified < deleted < unchanged so changes bubble up', () => {
        expect(changeRank('added')).toBeLessThan(changeRank('modified'));
        expect(changeRank('modified')).toBeLessThan(changeRank('deleted'));
        expect(changeRank('deleted')).toBeLessThan(changeRank('unchanged'));
        expect(changeRank(undefined)).toBe(changeRank('unchanged'));
    });
    it('sorting an array changed-first keeps changed rows on top', () => {
        const arr = items(['unchanged', 'modified', 'unchanged', 'added', 'deleted']);
        const sorted = [...arr].sort((a, b) => changeRank(a.diff) - changeRank(b.diff));
        expect(sorted.map((x) => x.diff)).toEqual(['added', 'modified', 'deleted', 'unchanged', 'unchanged']);
    });
    it('is a STABLE-friendly total order (equal ranks preserve input order via a stable sort)', () => {
        const arr = [{ id: 'a', diff: 'added' }, { id: 'b', diff: 'added' }, { id: 'c', diff: 'unchanged' }];
        const sorted = [...arr].sort((x, y) => changeRank(x.diff) - changeRank(y.diff));
        expect(sorted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('groupHasChanges (auto-expand / hide gate)', () => {
    it('true when any item changed', () => {
        expect(groupHasChanges(items(['unchanged', 'modified']))).toBe(true);
    });
    it('false when all unchanged (feature auto-collapsed / hidden under Changed filter)', () => {
        expect(groupHasChanges(items(['unchanged', undefined]))).toBe(false);
    });
    it('false for empty', () => {
        expect(groupHasChanges([])).toBe(false);
    });
    it('also honors a group-level diff (e.g. an added feature whose rows read unchanged)', () => {
        expect(groupHasChanges(items(['unchanged']), 'added')).toBe(true);
        expect(groupHasChanges(items(['unchanged']), 'unchanged')).toBe(false);
    });
});

describe('orderedChangedIds (jump stepper order)', () => {
    it('returns ids of changed items in display order', () => {
        const displayed = items(['added', 'unchanged', 'modified', 'unchanged', 'deleted']);
        expect(orderedChangedIds(displayed, (x) => x.id)).toEqual(['n0', 'n2', 'n4']);
    });
    it('empty when nothing changed', () => {
        expect(orderedChangedIds(items(['unchanged', undefined]), (x) => x.id)).toEqual([]);
    });
});
