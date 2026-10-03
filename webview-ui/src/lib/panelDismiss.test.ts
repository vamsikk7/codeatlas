import { describe, it, expect } from 'vitest';
import { shouldDismissFileScopedPanel } from './panelDismiss';

describe('shouldDismissFileScopedPanel (BUG-EXPLORE-8)', () => {
    it('KEEPS the panel while exploring file-level views', () => {
        expect(shouldDismissFileScopedPanel('file:src/x.ts')).toBe(false);
        expect(shouldDismissFileScopedPanel('flow:src/x.ts:fn')).toBe(false);
        expect(shouldDismissFileScopedPanel('sequence:src/x.ts:fn')).toBe(false);
    });
    it('DISMISSES the panel when jumping to a non-file destination', () => {
        expect(shouldDismissFileScopedPanel('microservice:workspace')).toBe(true);
        expect(shouldDismissFileScopedPanel('feature:workspace')).toBe(true);
        expect(shouldDismissFileScopedPanel('domain:workspace')).toBe(true);
        expect(shouldDismissFileScopedPanel('map:workspace')).toBe(true);
        expect(shouldDismissFileScopedPanel('health:report')).toBe(true);
        expect(shouldDismissFileScopedPanel(null)).toBe(true);
    });
});
