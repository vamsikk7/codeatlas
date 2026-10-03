/**
 * middlewareTaggers.ts — UX-29 Phase 2 shim (2026-06-05)
 *
 * The per-framework taggers moved to `middlewareTaggers/<framework>.ts`
 * in Phase 2 so each framework has its own file (easier review,
 * per-framework test colocation, lower diff churn when adding a new
 * framework). This file is now a thin re-export shim — existing
 * `import { tagFoo } from './middlewareTaggers'` callers keep
 * working without code change.
 *
 * New code should prefer `import { … } from './middlewareTaggers/index'`
 * (or just `'./middlewareTaggers'` — TypeScript resolves the directory
 * to its `index.ts` when the `.ts` file is absent, but for now both
 * resolve here for safety).
 */

export * from './middlewareTaggers/index';
