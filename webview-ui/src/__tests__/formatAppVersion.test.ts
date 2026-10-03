/**
 * formatAppVersion.test.ts
 *
 * Unit tests for `formatAppVersion` — the single-source version-display
 * helper. Pins the rule: when the server passes `mcpServerVersion`
 * (standalone path), show that; otherwise fall back to the extension's
 * compile-time defines.
 *
 * Why this matters: a previous design showed both stamps side-by-side
 * (`v6.X.Y.Z · MCP 2.X.Y`) which was visually noisy and confusing. The
 * decision (2026-05-28) is one stamp per surface — whichever is actually
 * serving the webview.
 */
import { describe, it, expect } from 'vitest';
import { formatAppVersion } from '../App';

describe('formatAppVersion', () => {
    it('returns `CodeAtlas MCP v<x>` when mcpServerVersion is set', () => {
        expect(formatAppVersion('2.2.0')).toBe('CodeAtlas MCP v2.2.0');
    });

    it('returns `CodeAtlas MCP v<x>` for any non-empty MCP version (pre-release tags too)', () => {
        expect(formatAppVersion('3.0.0-rc.1')).toBe('CodeAtlas MCP v3.0.0-rc.1');
    });

    it('falls back to the compiled extension defines when mcpServerVersion is null', () => {
        const out = formatAppVersion(null);
        expect(out.startsWith('CodeAtlas v')).toBe(true);
        // __CODEATLAS_VERSION__ is injected by Vite at compile time;
        // its exact value depends on `package.json` so we don't pin
        // it here — just confirm it's not the MCP-shaped string.
        expect(out.includes('MCP')).toBe(false);
    });

    it('falls back to the compiled extension defines when mcpServerVersion is undefined', () => {
        expect(formatAppVersion(undefined).startsWith('CodeAtlas v')).toBe(true);
    });

    it('falls back to the compiled extension defines when mcpServerVersion is the empty string', () => {
        // Treat empty string as "not set" — matches the broadcast's
        // `?? null` convention on the server side.
        expect(formatAppVersion('').startsWith('CodeAtlas v')).toBe(true);
        expect(formatAppVersion('').includes('MCP')).toBe(false);
    });
});
