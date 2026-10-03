import { describe, it, expect } from 'vitest';
import { multiRepoStoresPopulated } from '../multiRepoGuards';

describe('multiRepoStoresPopulated (AutoInit skip-rescan guard)', () => {
    it('is populated when the merged apiIndex has entries', () => {
        expect(multiRepoStoresPopulated(1405, [0, 0, 0, 0])).toBe(true);
    });

    it('is populated when at least one per-repo store has files (apiIndex not yet aggregated)', () => {
        expect(multiRepoStoresPopulated(0, [0, 1705, 0, 1438])).toBe(true);
    });

    it('is EMPTY when apiIndex is empty AND every per-repo store has 0 files (interrupted resync)', () => {
        // This is the OOM-thrash case: skipping here would falsely broadcast "complete".
        expect(multiRepoStoresPopulated(0, [0, 0, 0, 0])).toBe(false);
    });

    it('is EMPTY when there are no per-repo stores at all', () => {
        expect(multiRepoStoresPopulated(0, [])).toBe(false);
    });
});
