/**
 * Audit S9 — one opt-out predicate shared by every telemetry surface.
 *
 * These tests pin the accepted values. They matter because the three surfaces
 * (extension Mixpanel, MCP Mixpanel, Sentry) used to disagree, and a user who
 * sets DO_NOT_TRACK must be silenced everywhere or the privacy claim in
 * PRIVACY.md is false.
 */
import { describe, it, expect } from 'vitest';
import { isTelemetryOptedOut } from '../telemetryOptOut';

describe('isTelemetryOptedOut', () => {
    it('defaults to opted IN when nothing is set', () => {
        expect(isTelemetryOptedOut({})).toBe(false);
    });

    describe('CODEATLAS_TELEMETRY', () => {
        for (const v of ['0', 'false', 'off', 'no']) {
            it(`opts out on "${v}"`, () => {
                expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: v })).toBe(true);
            });
        }
        for (const v of ['1', 'true', 'on', 'yes', '']) {
            it(`stays opted in on "${v}"`, () => {
                expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: v })).toBe(false);
            });
        }
        it('is case-insensitive and tolerates surrounding whitespace', () => {
            expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: '  OFF  ' })).toBe(true);
            expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: 'False' })).toBe(true);
        });
    });

    describe('DO_NOT_TRACK', () => {
        for (const v of ['1', 'true', 'yes']) {
            it(`opts out on "${v}"`, () => {
                expect(isTelemetryOptedOut({ DO_NOT_TRACK: v })).toBe(true);
            });
        }
        // DNT's convention is that only an explicit affirmative means "do not
        // track" — "0" means the user has expressed no preference, NOT consent
        // to be tracked beyond the default.
        for (const v of ['0', 'false', '']) {
            it(`stays opted in on "${v}"`, () => {
                expect(isTelemetryOptedOut({ DO_NOT_TRACK: v })).toBe(false);
            });
        }
        it('is case-insensitive', () => {
            expect(isTelemetryOptedOut({ DO_NOT_TRACK: 'TRUE' })).toBe(true);
        });
    });

    it('either signal alone is sufficient', () => {
        expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: 'on', DO_NOT_TRACK: '1' })).toBe(true);
        expect(isTelemetryOptedOut({ CODEATLAS_TELEMETRY: 'off', DO_NOT_TRACK: '0' })).toBe(true);
    });
});
