/**
 * mobile/types.ts — Mobile platform plugin contract
 * (Issue #703, Phase 2 — mobile-detector extraction).
 *
 * Companion to `frameworks/types.ts` for the same plugin-architecture
 * refactor. Mobile platforms are simpler than framework plugins because
 * they don't have route-pattern tables — each platform's `detect()` is
 * a self-contained function that walks the source for screens,
 * navigation routes, network calls, and DI bindings, returning the
 * familiar `ApiRecord[]` shape with synthetic methods
 * (`SCREEN` / `NAV_ROUTE` / `NETWORK` / `DI_BINDING`).
 *
 * Phase 1 (this PR): types + registry + per-platform plugins for
 * Android, iOS, React/React Native, and Flutter. `mobileDetector.ts`
 * becomes a thin dispatcher (~30 LOC).
 */

import type { ApiRecord } from '../../graph/graphTypes';
import type { SupportedLanguage } from '../treeSitterParser';

/**
 * One mobile platform — Android, iOS, React (web or RN), Flutter.
 * Each plugin owns its own detection regexes + extraction logic and
 * exposes a single `detect()` entry point.
 */
export interface MobilePlatformPlugin {
    /**
     * Unique platform id. Used by the registry for dedup checks and by
     * tests for targeted invocation (e.g. "run only the android plugin
     * on this fixture"). Names are deliberately lowercase + hyphen-free
     * so they read cleanly in log lines and Mixpanel tags.
     */
    id: 'android' | 'ios' | 'react' | 'flutter' | 'xamarin';

    /**
     * Languages this plugin runs against. The dispatcher consults the
     * registry by language, so a Flutter plugin only sees Dart source,
     * an iOS plugin only sees Swift, etc. Multi-language plugins
     * (Android = Java + Kotlin) declare both.
     */
    languages: SupportedLanguage[];

    /**
     * Run the plugin against one file. Receives the raw source + path
     * + language so each plugin can apply its own gates (import-presence
     * checks, path-based screen detection, test-file exclusion). Returns
     * zero-or-more `ApiRecord`s; the dispatcher concatenates results
     * across plugins.
     *
     * Each plugin is expected to:
     *   - Bail out fast for non-applicable files (cheap regex on import statements)
     *   - Skip test files where the framework's annotations show up but aren't real entry points
     *   - Use stable apiIds derived from `(method, route, filePath, handlerName)`
     */
    detect(source: string, filePath: string, language: SupportedLanguage): ApiRecord[];
}
