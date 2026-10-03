/**
 * mobile/registry.ts — Per-language mobile platform plugin registry
 * (Issue #703, mobile-detector extraction).
 *
 * Mirrors the shape of `frameworks/registry.ts` so the two registries
 * read identically. Holds the set of registered `MobilePlatformPlugin`s
 * and provides lookup by `SupportedLanguage`. The dispatcher in
 * `mobileDetector.ts` asks for plugins claiming the file's language and
 * concatenates the per-plugin results.
 *
 * Conflict policy: duplicate plugin ids throw at registration time.
 */

import type { MobilePlatformPlugin } from './types';
import type { SupportedLanguage } from '../treeSitterParser';

export class MobilePlatformRegistry {
    private byId = new Map<string, MobilePlatformPlugin>();
    private byLanguage = new Map<SupportedLanguage, MobilePlatformPlugin[]>();

    register(plugin: MobilePlatformPlugin): void {
        if (this.byId.has(plugin.id)) {
            throw new Error(
                `[MobilePlatformRegistry] Duplicate plugin id "${plugin.id}". ` +
                `Plugin ids must be unique; check for accidental double-registration.`,
            );
        }
        if (!plugin.languages || plugin.languages.length === 0) {
            throw new Error(
                `[MobilePlatformRegistry] Plugin "${plugin.id}" declared zero languages. ` +
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

    getForLanguage(language: SupportedLanguage): MobilePlatformPlugin[] {
        return [...(this.byLanguage.get(language) ?? [])];
    }

    getById(id: string): MobilePlatformPlugin | undefined {
        return this.byId.get(id);
    }

    all(): MobilePlatformPlugin[] {
        return [...this.byId.values()];
    }

    size(): number {
        return this.byId.size;
    }

    _clearForTests(): void {
        this.byId.clear();
        this.byLanguage.clear();
    }
}
