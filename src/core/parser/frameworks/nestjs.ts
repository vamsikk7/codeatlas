/**
 * frameworks/nestjs.ts — NestJS framework plugin
 * (Issue #703, Phase 2 — first per-framework extraction from
 *  `frameworkDetector.ts`. The next per-framework plugin should follow
 *  this file's shape.)
 *
 * NestJS uses TypeScript decorators on controller methods for routing:
 *
 *   @Controller('/users')
 *   export class UsersController {
 *     @Get('/')      findAll() { … }
 *     @Get(':id')    findOne() { … }
 *     @Post()        create()  { … }
 *   }
 *
 * Two patterns own this plugin:
 *   1. Method-level route decorators: `@Get`, `@Post`, `@Put`, `@Patch`,
 *      `@Delete`, `@Options`, `@Head`, `@All`.
 *   2. Class-level prefix decorator: `@Controller('/prefix')`.
 *   3. Terminus health-check decorator: `@HealthCheck()` (added in PR-9).
 *
 * The class-level prefix is emitted as a `CONTROLLER` synthetic method —
 * downstream consumers (the L2b api-list panel) treat it as a
 * prefix-binding marker, not a real endpoint.
 *
 * The Terminus `@HealthCheck()` decorator emits a `HEALTH` record so the
 * L2b Observability section can surface health/readiness endpoints
 * regardless of their HTTP path. Path-based health auto-retag still lives
 * in the dispatcher's tag pass — this decorator is the explicit form.
 *
 * `skipInsideTemplate: true` preserves the pre-#703 behaviour where the
 * dispatcher suppressed every JS_PATTERNS entry inside template
 * literals. In practice TS decorators don't appear inside backtick
 * strings, so the flag is defensive — required for byte-identical
 * `verify:real` output against fixtures like `svelte-docs` whose
 * markdown includes JSX snippets in template literals.
 */

import type { FrameworkPlugin } from './types';
import { findNearestFunctionName } from '../frameworkDetector';

export const nestjsPlugin: FrameworkPlugin = {
    id: 'nestjs',
    name: 'NestJS',
    languages: ['javascript', 'typescript'],
    patterns: [
        // Method-level route decorators: @Get('/path'), @Post('/path'), …
        {
            decoratorPattern: /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*['"`]?([^'"`)\s]*)['"`]?\s*\)/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] || '/' }),
            skipInsideTemplate: true,
        },
        // Class-level @Controller('/prefix') — emitted as a CONTROLLER marker
        // so the L2b api-list panel can resolve the class's prefix when
        // composing method-level routes.
        {
            decoratorPattern: /@Controller\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gi,
            extract: (m) => ({ method: 'CONTROLLER', route: m[1] }),
            skipInsideTemplate: true,
        },
        // Terminus @HealthCheck() — emits a HEALTH record. The route is
        // synthesised from the nearest function name (Terminus is always
        // applied to a method, so this is reliable). Path-based health
        // detection is a separate dispatcher pass.
        {
            decoratorPattern: /@HealthCheck\s*\(\s*\)/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'HEALTH', route: `health:${handlerName}`, handlerName };
            },
            skipInsideTemplate: true,
        },
    ],
};
