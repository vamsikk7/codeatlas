import { describe, it, expect } from 'vitest';
import { shouldRemindOpenSource, OSS_REMINDER_INTERVAL_MS } from '../ossReminder';

const base = { now: 1_000_000_000_000, lastShownMs: 0, registered: false, optOut: false };

describe('shouldRemindOpenSource', () => {
    it('shows when never shown before, not registered, not opted out', () => {
        expect(shouldRemindOpenSource(base)).toBe(true);
    });

    it('does NOT show when opted out', () => {
        expect(shouldRemindOpenSource({ ...base, optOut: true })).toBe(false);
    });

    it('does NOT show when already registered', () => {
        expect(shouldRemindOpenSource({ ...base, registered: true })).toBe(false);
    });

    it('does NOT show within the 24h window', () => {
        expect(shouldRemindOpenSource({ ...base, lastShownMs: base.now - (OSS_REMINDER_INTERVAL_MS - 1) })).toBe(false);
    });

    it('shows again once 24h have elapsed', () => {
        expect(shouldRemindOpenSource({ ...base, lastShownMs: base.now - OSS_REMINDER_INTERVAL_MS })).toBe(true);
    });

    it('opt-out and registered both dominate the throttle', () => {
        const due = { ...base, lastShownMs: base.now - OSS_REMINDER_INTERVAL_MS * 2 };
        expect(shouldRemindOpenSource({ ...due, optOut: true })).toBe(false);
        expect(shouldRemindOpenSource({ ...due, registered: true })).toBe(false);
    });

    it('respects a custom interval', () => {
        expect(shouldRemindOpenSource({ ...base, lastShownMs: base.now - 5000, intervalMs: 10_000 })).toBe(false);
        expect(shouldRemindOpenSource({ ...base, lastShownMs: base.now - 20_000, intervalMs: 10_000 })).toBe(true);
    });
});
