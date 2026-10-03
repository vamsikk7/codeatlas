import { describe, it, expect } from 'vitest';
import { tourEmptyMessage } from '../tourMessages';

describe('tourEmptyMessage (BUG-POLAR-26 — mode-aware tour empty state)', () => {
    it('recent-changes tour on a clean workspace does NOT tell the user to initialize', () => {
        const msg = tourEmptyMessage('recent', false);
        expect(msg).toMatch(/no recent changes/i);
        expect(msg).not.toMatch(/initialize the workspace/i);
    });

    it('codebase tour keeps the initialize hint when there are no steps', () => {
        expect(tourEmptyMessage('codebase', false)).toMatch(/initialize the workspace/i);
    });

    it('shows a loading message while building, for either mode', () => {
        expect(tourEmptyMessage('recent', true)).toBe('Building tour…');
        expect(tourEmptyMessage('codebase', true)).toBe('Building tour…');
    });
});
