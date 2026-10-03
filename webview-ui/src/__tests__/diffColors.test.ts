import { describe, it, expect } from 'vitest';
import { EDGE_DIFF_COLORS, NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';

const ALL_STATUSES = ['added', 'deleted', 'modified', 'unchanged'];

describe('DIFF_SYMBOLS', () => {
    it('has entries for all diff statuses', () => {
        for (const status of ALL_STATUSES) {
            expect(DIFF_SYMBOLS).toHaveProperty(status);
        }
    });

    it('added symbol is +', () => expect(DIFF_SYMBOLS.added).toBe('+'));
    it('deleted symbol is −', () => expect(DIFF_SYMBOLS.deleted).toBe('−'));
    it('modified symbol is ~', () => expect(DIFF_SYMBOLS.modified).toBe('~'));
    it('unchanged symbol is empty', () => expect(DIFF_SYMBOLS.unchanged).toBe(''));
});

describe('DIFF_BORDER_STYLES', () => {
    it('has entries for all diff statuses', () => {
        for (const status of ALL_STATUSES) {
            expect(DIFF_BORDER_STYLES).toHaveProperty(status);
        }
    });

    it('added uses solid border', () => expect(DIFF_BORDER_STYLES.added).toBe('solid'));
    it('deleted uses dashed border', () => expect(DIFF_BORDER_STYLES.deleted).toBe('dashed'));
    it('modified uses dotted border', () => expect(DIFF_BORDER_STYLES.modified).toBe('dotted'));
    it('unchanged uses solid border', () => expect(DIFF_BORDER_STYLES.unchanged).toBe('solid'));
});

describe('NODE_DIFF_COLORS', () => {
    it('has entries for all diff statuses', () => {
        for (const status of ALL_STATUSES) {
            expect(NODE_DIFF_COLORS).toHaveProperty(status);
            const entry = NODE_DIFF_COLORS[status];
            expect(entry).toHaveProperty('bg');
            expect(entry).toHaveProperty('border');
            expect(entry).toHaveProperty('glow');
            expect(entry).toHaveProperty('text');
        }
    });

    it('all colors use CSS custom properties', () => {
        for (const status of ALL_STATUSES) {
            const entry = NODE_DIFF_COLORS[status];
            expect(entry.bg).toMatch(/^var\(--ca-|^transparent$/);
            expect(entry.border).toMatch(/^var\(--ca-/);
        }
    });
});

describe('EDGE_DIFF_COLORS', () => {
    it('has entries for all diff statuses', () => {
        for (const status of ALL_STATUSES) {
            expect(EDGE_DIFF_COLORS).toHaveProperty(status);
            expect(typeof EDGE_DIFF_COLORS[status]).toBe('string');
        }
    });
});
