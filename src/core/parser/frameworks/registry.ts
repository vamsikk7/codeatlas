/**
 * frameworks/registry.ts — Per-language framework plugin registry
 * (Issue #703, Phase 1 of the v2 plugin architecture refactor).
 *
 * Holds the set of registered `FrameworkPlugin`s and provides lookup by
 * language. The dispatcher (`frameworkDetector.ts`) will consult this
 * registry once Phase 2+ migrations land — Phase 1 only ships the
 * scaffolding, no plugins registered yet, no dispatcher changes.
 *
 * Conflict policy: registering two plugins with the same `id` throws.
 * This catches accidental double-registration (e.g. when a plugin file is
 * imported twice via barrel re-exports) at module-load time rather than
 * silently overwriting.
 *
 * No dynamic discovery. Plugins are registered explicitly via
 * `frameworks/index.ts` so the bundle's import graph stays static (no
 * runtime fs walks in the extension host).
 */

import type { FrameworkPlugin } from './types';
import type { SupportedLanguage } from '../treeSitterParser';

export class FrameworkRegistry {
    private byId = new Map<string, FrameworkPlugin>();
    private byLanguage = new Map<SupportedLanguage, FrameworkPlugin[]>();

    /**
     * Register a plugin. Throws if a plugin with the same `id` is already
     * registered — this surfaces duplicate-import bugs at startup rather
     * than producing inconsistent route lists at detection time.
     */
    register(plugin: FrameworkPlugin): void {
        if (this.byId.has(plugin.id)) {
            throw new Error(
                `[FrameworkRegistry] Duplicate plugin id "${plugin.id}". ` +
                `Plugin ids must be unique; check for accidental double-registration.`,
            );
        }
        if (!plugin.languages || plugin.languages.length === 0) {
            throw new Error(
                `[FrameworkRegistry] Plugin "${plugin.id}" declared zero languages. ` +
                `Every plugin must claim at least one SupportedLanguage.`,
            );
        }
        this.byId.set(plugin.id, plugin);
        for (const lang of plugin.languages) {
            const bucket = this.byLanguage.get(lang) ?? [];
            bucket.push(plugin);
            this.byLanguage.set(lang, bucket);
        }
    }

    /** Return all plugins claiming `language`. Insertion order preserved. */
    getForLanguage(language: SupportedLanguage): FrameworkPlugin[] {
        return [...(this.byLanguage.get(language) ?? [])];
    }

    /** Return a plugin by id, or `undefined` if not registered. */
    getById(id: string): FrameworkPlugin | undefined {
        return this.byId.get(id);
    }

    /** Return every registered plugin in insertion order. */
    all(): FrameworkPlugin[] {
        return [...this.byId.values()];
    }

    /** Number of registered plugins (for telemetry / smoke tests). */
    size(): number {
        return this.byId.size;
    }

    /**
     * Test-only: clear the registry. Used by unit tests to ensure each
     * test runs against a fresh registry without leaking state from
     * sibling tests. Never call this from production code.
     */
    _clearForTests(): void {
        this.byId.clear();
        this.byLanguage.clear();
    }
}
