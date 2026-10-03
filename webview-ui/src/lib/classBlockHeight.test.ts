import { describe, it, expect } from 'vitest';
import { classBlockNodeHeight, CLASS_BLOCK_HEADER_HEIGHT, CLASS_BLOCK_MAX_ITEMS_HEIGHT } from './classBlockHeight';

describe('classBlockNodeHeight (BUG-POLAR-5 — size L4 section boxes so they do not overlap)', () => {
    it('grows with item count (3 functions ≈ 134px)', () => {
        expect(classBlockNodeHeight(3)).toBe(CLASS_BLOCK_HEADER_HEIGHT + 90);
        expect(classBlockNodeHeight(6)).toBe(CLASS_BLOCK_HEADER_HEIGHT + 180);
    });
    it('a 41-import section is much taller than the old fixed NODE_HEIGHT (80) — the overlap cause', () => {
        expect(classBlockNodeHeight(41)).toBeGreaterThan(80);
        // capped at header + list max so a huge section does not grow unbounded.
        expect(classBlockNodeHeight(41)).toBe(CLASS_BLOCK_HEADER_HEIGHT + CLASS_BLOCK_MAX_ITEMS_HEIGHT);
    });
    it('caps at the scroll max (100 items same height as 41)', () => {
        expect(classBlockNodeHeight(100)).toBe(classBlockNodeHeight(41));
    });
    it('handles 0/negative gracefully (header only)', () => {
        expect(classBlockNodeHeight(0)).toBe(CLASS_BLOCK_HEADER_HEIGHT);
        expect(classBlockNodeHeight(-5)).toBe(CLASS_BLOCK_HEADER_HEIGHT);
    });
});
