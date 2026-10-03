import { describe, it, expect } from 'vitest';
import { overlayEmptyToastDecision } from './overlayEmptyToast';

describe('overlayEmptyToastDecision (BUG-EXPLORE-16)', () => {
    it('toasts the empty hint the first time an enabled overlay reports no data', () => {
        const shown = new Set<string>();
        const r = overlayEmptyToastDecision(
            { overlayId: 'coverage', empty: true, emptyHint: 'No LCOV / Istanbul coverage data found — run your tests with coverage first.' },
            shown,
        );
        expect(r.toast).toContain('No LCOV');
        expect(shown.has('coverage')).toBe(true);
    });

    it('does NOT re-toast on repeat empty payloads (e.g. navigating between graphs)', () => {
        const shown = new Set<string>();
        overlayEmptyToastDecision({ overlayId: 'coverage', empty: true, emptyHint: 'x' }, shown);
        const second = overlayEmptyToastDecision({ overlayId: 'coverage', empty: true, emptyHint: 'x' }, shown);
        expect(second.toast).toBeNull();
    });

    it('never toasts when data is present', () => {
        const shown = new Set<string>();
        const r = overlayEmptyToastDecision({ overlayId: 'coverage', empty: false }, shown);
        expect(r.toast).toBeNull();
        expect(shown.has('coverage')).toBe(false);
    });

    it('re-arms after data appears, so a later empty episode toasts again', () => {
        const shown = new Set<string>();
        overlayEmptyToastDecision({ overlayId: 'coverage', empty: true, emptyHint: 'x' }, shown);
        overlayEmptyToastDecision({ overlayId: 'coverage', empty: false }, shown); // data arrived → re-arm
        const again = overlayEmptyToastDecision({ overlayId: 'coverage', empty: true, emptyHint: 'y' }, shown);
        expect(again.toast).toBe('y');
    });

    it('falls back to a generic message when no emptyHint is supplied', () => {
        const shown = new Set<string>();
        const r = overlayEmptyToastDecision({ overlayId: 'sentry', empty: true }, shown);
        expect(r.toast).toContain('sentry');
        expect(r.toast).toContain('nothing to paint');
    });
});
