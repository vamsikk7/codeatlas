/**
 * overlayRegistry.ts — #826 R2/R2b (2026-06-11).
 *
 * Single registry both transports share. Toggle state persists per
 * workspace via an injected store hook (the SnapshotStore `singletons`
 * table — additive, no schema bump); the optional `layer` field on each
 * row is reserved so per-layer overrides (v2) stay additive.
 *
 * Low-noise defaults (R2b): `diff` ON (core value prop), everything else
 * OFF until the user opts in. `diff` is registered as a descriptor for
 * the panel/toggle surface, but its write path stays the cascade (R6
 * migrates the render side later).
 */

import type { OverlayDescriptor, OverlayStateRow } from './overlayTypes';

export interface OverlayStatePersistence {
    loadRows(): OverlayStateRow[] | undefined;
    saveRows(rows: OverlayStateRow[]): void;
}

const DEFAULT_ENABLED = new Set(['diff']);

export class OverlayRegistry {
    private readonly descriptors = new Map<string, OverlayDescriptor>();
    private rows = new Map<string, OverlayStateRow>();
    private persistence: OverlayStatePersistence | null = null;
    private listeners: Array<(rows: OverlayStateRow[]) => void> = [];

    register(descriptor: OverlayDescriptor): void {
        this.descriptors.set(descriptor.id, descriptor);
        if (!this.rows.has(descriptor.id)) {
            this.rows.set(descriptor.id, {
                overlayId: descriptor.id,
                enabled: DEFAULT_ENABLED.has(descriptor.id),
            });
        }
    }

    get(id: string): OverlayDescriptor | undefined {
        return this.descriptors.get(id);
    }

    list(): Array<{ descriptor: OverlayDescriptor; enabled: boolean }> {
        return [...this.descriptors.values()].map((d) => ({
            descriptor: d,
            enabled: this.rows.get(d.id)?.enabled ?? false,
        }));
    }

    isEnabled(id: string): boolean {
        return this.rows.get(id)?.enabled ?? false;
    }

    setEnabled(id: string, enabled: boolean): void {
        const row = this.rows.get(id) ?? { overlayId: id, enabled };
        row.enabled = enabled;
        this.rows.set(id, row);
        this.persist();
        const snapshot = this.stateRows();
        for (const l of this.listeners) {
            try { l(snapshot); } catch { /* listener errors never break toggles */ }
        }
    }

    /** Count of enabled paint-heavy overlays — drives the soft-cap hint. */
    enabledCount(): number {
        return [...this.rows.values()].filter((r) => r.enabled).length;
    }

    stateRows(): OverlayStateRow[] {
        return [...this.rows.values()].map((r) => ({ ...r }));
    }

    onStateChanged(listener: (rows: OverlayStateRow[]) => void): void {
        this.listeners.push(listener);
    }

    attachPersistence(p: OverlayStatePersistence): void {
        this.persistence = p;
        const loaded = p.loadRows();
        if (loaded) {
            for (const row of loaded) {
                const existing = this.rows.get(row.overlayId);
                if (existing) existing.enabled = row.enabled;
                else this.rows.set(row.overlayId, { ...row });
            }
        }
    }

    private persist(): void {
        try { this.persistence?.saveRows(this.stateRows()); } catch { /* best-effort */ }
    }
}
