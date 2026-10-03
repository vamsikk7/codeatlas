/**
 * mobile/index.ts — Module-level singleton + auto-registration
 * (Issue #703, Phase 2 — mobile-detector extraction).
 *
 * Mirrors `frameworks/index.ts`. One singleton `mobilePlatformRegistry`
 * instance lives here; per-platform files (Android, iOS, React, Flutter)
 * export their `MobilePlatformPlugin` and are registered against this
 * singleton at module-load time.
 *
 * The dispatcher in `mobileDetector.ts` imports this module and asks the
 * singleton for plugins claiming the file's language, then concatenates
 * the per-plugin results — same shape as the framework dispatcher.
 *
 * Test code that needs a clean registry should construct its own
 * `MobilePlatformRegistry` instance rather than calling `_clearForTests()`
 * on this singleton.
 */

import { MobilePlatformRegistry } from './registry';

export { MobilePlatformRegistry } from './registry';
export type { MobilePlatformPlugin } from './types';

export const mobilePlatformRegistry = new MobilePlatformRegistry();

// ─── Plugin registration ──────────────────────────────────────────────────
// Order doesn't matter — the dispatcher iterates per file's language and
// the registry preserves insertion order within a language for
// deterministic output.

import { androidPlugin } from './android';
import { iosPlugin } from './ios';
import { reactPlugin } from './react';
import { flutterPlugin } from './flutter';
import { xamarinPlugin } from './xamarin';

mobilePlatformRegistry.register(androidPlugin);
mobilePlatformRegistry.register(iosPlugin);
mobilePlatformRegistry.register(reactPlugin);
mobilePlatformRegistry.register(flutterPlugin);
mobilePlatformRegistry.register(xamarinPlugin);
