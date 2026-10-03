/**
 * frameworks/index.ts — Module-level singleton + auto-registration
 * (Issue #703, Phase 1 of the v2 plugin architecture refactor).
 *
 * One singleton `frameworkRegistry` instance lives here. Per-framework
 * files (Express, NestJS, Spring, FastAPI, …) will import this singleton
 * and register themselves on module load in later PRs.
 *
 * Phase 1 (this PR): the registry is empty. The dispatcher in
 * `frameworkDetector.ts` is unchanged and continues to consult its
 * inline `FRAMEWORK_PATTERNS` tables. Importing this module does not
 * mutate any other module's behavior; it just makes the singleton
 * available for future extraction work.
 *
 * Phase 2+ (later PRs): each per-framework file imports
 * `frameworkRegistry` from this module and calls `register(...)` at the
 * top level. Order doesn't matter since the dispatcher will iterate the
 * registry per file's language.
 */

import { FrameworkRegistry } from './registry';

export { FrameworkRegistry } from './registry';
export type {
    FrameworkPlugin,
    RoutePattern,
    DetectionContext,
    ExtractResult,
    ExtractResultWithAnchor,
} from './types';

/**
 * Singleton framework plugin registry. Per-framework plugin files
 * register themselves against this instance at module-load time.
 *
 * Test code that needs a clean registry should construct its own
 * `FrameworkRegistry` instance rather than using `_clearForTests()` on
 * this singleton — clearing the singleton would leave production code
 * paths broken for the rest of the test process.
 */
export const frameworkRegistry = new FrameworkRegistry();

// ─── Plugin registration (Phase 2+ — one entry per extracted framework) ──
// Each plugin file exports a `FrameworkPlugin`. We register them here so
// imports of `frameworks/index.ts` get a populated registry without each
// plugin file performing its own side-effectful self-registration (which
// would surprise readers who don't expect import-time mutations).
//
// Order doesn't matter — the dispatcher iterates per file's language and
// the registry preserves insertion order within a language for
// deterministic output.

import { nestjsPlugin } from './nestjs';
import { bullPlugin } from './bull';
import { mqConsumersPlugin } from './mq-consumers';
import { ormHooksPlugin } from './orm-hooks';
import { migrationsPlugin } from './migrations';
import { socketIoPlugin } from './socket-io';
import { nodeEventsPlugin } from './node-events';
import { honoPlugin } from './hono';
import { nodeHttpPlugin } from './node-http';
import { metaFrameworksPlugin } from './meta-frameworks';
import { pythonPlugin } from './python';
import { javaSpringPlugin, ktorPlugin } from './jvm';
import { goPlugin } from './go';
import { rustPlugin, csharpPlugin, phpPlugin, rubyPlugin, swiftPlugin } from './single-lang';
import { graphqlPlugin } from './graphql';
import { grpcPlugin } from './grpc';

frameworkRegistry.register(nestjsPlugin);
frameworkRegistry.register(bullPlugin);
frameworkRegistry.register(mqConsumersPlugin);
frameworkRegistry.register(ormHooksPlugin);
frameworkRegistry.register(migrationsPlugin);
frameworkRegistry.register(socketIoPlugin);
frameworkRegistry.register(nodeEventsPlugin);
frameworkRegistry.register(honoPlugin);
frameworkRegistry.register(nodeHttpPlugin);
frameworkRegistry.register(metaFrameworksPlugin);
frameworkRegistry.register(pythonPlugin);
frameworkRegistry.register(javaSpringPlugin);
frameworkRegistry.register(ktorPlugin);
frameworkRegistry.register(goPlugin);
frameworkRegistry.register(rustPlugin);
frameworkRegistry.register(csharpPlugin);
frameworkRegistry.register(phpPlugin);
frameworkRegistry.register(rubyPlugin);
frameworkRegistry.register(swiftPlugin);
frameworkRegistry.register(graphqlPlugin);
frameworkRegistry.register(grpcPlugin);
