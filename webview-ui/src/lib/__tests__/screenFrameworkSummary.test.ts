import { describe, it, expect } from 'vitest';
import { screenFrameworkBreakdown, formatScreenFrameworkLabel } from '../screenFrameworkSummary';

const scr = (framework: string) => ({ meta: { framework } });

describe('screenFrameworkSummary (BUG-POLAR-25 — FE L2a header vs row mismatch)', () => {
    it('shows a per-framework breakdown when screens span multiple frameworks', () => {
        const screens = [
            ...Array(220).fill(0).map(() => scr('expo-router')),
            ...Array(201).fill(0).map(() => scr('nextjs-app')),
        ];
        expect(formatScreenFrameworkLabel(screens, 'expo-router')).toBe('expo-router 220 · nextjs-app 201');
    });

    it('shows a single framework name (matching the rows) when uniform', () => {
        const screens = [scr('nextjs-app'), scr('nextjs-app'), scr('nextjs-app')];
        expect(formatScreenFrameworkLabel(screens, 'nextjs-app')).toBe('nextjs-app');
    });

    it('caps the breakdown to the top 3 frameworks', () => {
        const screens = [
            ...Array(10).fill(0).map(() => scr('a')),
            ...Array(8).fill(0).map(() => scr('b')),
            ...Array(6).fill(0).map(() => scr('c')),
            ...Array(4).fill(0).map(() => scr('d')),
        ];
        expect(formatScreenFrameworkLabel(screens)).toBe('a 10 · b 8 · c 6');
    });

    it('falls back to the dominant label when no per-screen framework metadata exists', () => {
        expect(formatScreenFrameworkLabel([{ meta: {} }], 'react-native')).toBe('react-native');
    });

    it('breakdown ignores unknown/empty frameworks', () => {
        const bd = screenFrameworkBreakdown([scr('nextjs-app'), scr('unknown'), { meta: {} }]);
        expect(bd).toEqual([{ framework: 'nextjs-app', count: 1 }]);
    });
});
