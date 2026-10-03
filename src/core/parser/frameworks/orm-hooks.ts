/**
 * frameworks/orm-hooks.ts — ORM lifecycle hooks (TypeORM, Mongoose, Sequelize)
 * (Issue #703, Phase 2 — fourth per-framework extraction; bundles the
 *  three Node ORM libraries that emit `MODEL_HOOK`.)
 *
 * Each ORM has its own lifecycle-hook API shape:
 *
 *   - **Mongoose** — `schema.pre('save', fn)` / `schema.post('save', fn)`
 *     on a Schema instance.
 *   - **TypeORM** — class-level decorators inside an entity class:
 *     `@BeforeInsert()`, `@AfterUpdate()`, `@BeforeRemove()`, etc.
 *     11 distinct decorators; we match all of them in one regex.
 *   - **Sequelize** — `Model.addHook('beforeCreate', fn)`, or via the
 *     definition-time `hooks: { … }` map. We catch the `.addHook(...)`
 *     call form here; the definition-time `hooks:` form is harder to
 *     match deterministically and is captured by the apiDetector pass.
 *
 * All three produce a `MODEL_HOOK` record with a transport prefix
 * (`save:`/`afterinsert:`/`sequelize:`) on the route so the L2b Data
 * Lifecycle section can distinguish them by source ORM.
 *
 * Gating:
 *   - Mongoose pattern is gated by a `mongoose` import; without it the
 *     regex would match any `X.pre('y', fn)` call (e.g. a custom
 *     middleware preprocessor).
 *   - Sequelize pattern is gated by a `sequelize` import for the same
 *     reason (any `.addHook(...)` call would otherwise match).
 *   - TypeORM decorators are unambiguous (`@BeforeInsert` etc. only
 *     come from TypeORM in real-world code) so no import gating needed.
 */

import type { FrameworkPlugin } from './types';
import { findNearestFunctionName } from '../frameworkDetector';

const MONGOOSE_IMPORT = /(?:from\s+|require\s*\(\s*)['"]mongoose['"]/;
const SEQUELIZE_IMPORT = /(?:from\s+|require\s*\(\s*)['"]sequelize['"]/;

export const ormHooksPlugin: FrameworkPlugin = {
    id: 'orm-hooks',
    name: 'ORM Lifecycle Hooks (Mongoose / TypeORM / Sequelize)',
    languages: ['javascript', 'typescript'],
    patterns: [
        // Mongoose: schema.pre('save', fn) / schema.post('save', fn)
        {
            callPattern: /\b(\w+)\s*\.\s*(pre|post)\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!MONGOOSE_IMPORT.test(ctx.source)) return null;
                return { method: 'MODEL_HOOK', route: `${m[2]}:${m[3]}`, handlerName: `${m[2]}_${m[3]}` };
            },
            skipInsideTemplate: true,
        },
        // TypeORM entity decorators — 11 lifecycle decorator names matched
        // in one regex. Decorator-only, unambiguous, no import gate needed.
        // The handler name is the immediately-following method declaration
        // (resolved via the shared `findNearestFunctionName` helper).
        {
            decoratorPattern: /@(BeforeInsert|AfterInsert|BeforeUpdate|AfterUpdate|BeforeRemove|AfterRemove|BeforeRecover|AfterRecover|BeforeSoftRemove|AfterSoftRemove|AfterLoad)\s*\(\s*\)/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MODEL_HOOK', route: `${m[1].toLowerCase()}:${handlerName}`, handlerName };
            },
            skipInsideTemplate: true,
        },
        // Sequelize: Model.addHook('beforeCreate', fn)
        {
            callPattern: /\.addHook\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!SEQUELIZE_IMPORT.test(ctx.source)) return null;
                return { method: 'MODEL_HOOK', route: `sequelize:${m[1]}`, handlerName: m[1] };
            },
            skipInsideTemplate: true,
        },
    ],
};
