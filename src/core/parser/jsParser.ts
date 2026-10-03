import { parse, ParserPlugin } from '@babel/parser';
import type { File } from '@babel/types';

// Plugins that are always safe to enable, regardless of language flavor.
const COMMON_PLUGINS: ParserPlugin[] = [
    'classProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport',
    // Issue 264: NestJS / TypeORM / class-validator etc. require legacy decorator
    // syntax. Without this plugin, ~23 of 35 ts-nestjs files fail to parse and
    // disappear from API detection (which is what triggers Issue 254 — NestJS controllers in `lujakob/nestjs-realworld-example-app` detect 0 APIs).
    'decorators-legacy',
    'decoratorAutoAccessors',
    'explicitResourceManagement',
];

function pluginsFor(filePath?: string): ParserPlugin[] {
    const ext = (filePath ?? '').toLowerCase();
    const isTsx = ext.endsWith('.tsx');
    const isJsx = ext.endsWith('.jsx');
    const isTs = ext.endsWith('.ts') || ext.endsWith('.mts') || ext.endsWith('.cts');

    // The Babel docs note that enabling both `jsx` and `typescript` makes
    // `<Type>expr` cast syntax ambiguous with JSX. .ts files use cast syntax
    // (e.g. `<RequestAndOptions>{...}` in apolloFetch.ts at packages/
    // integration-testsuite/src/apolloFetch.ts:133) — we must NOT enable jsx
    // for them. .tsx and .jsx files want jsx; non-TS .js can take both.
    if (isTsx) return [...COMMON_PLUGINS, 'jsx', 'typescript'];
    if (isTs) return [...COMMON_PLUGINS, 'typescript'];
    if (isJsx) return [...COMMON_PLUGINS, 'jsx'];
    // Plain .js / unknown: include both — covers most legacy code.
    return [...COMMON_PLUGINS, 'jsx', 'typescript'];
}

/**
 * Parse JavaScript source code into a Babel AST.
 * Supports ES modules, CommonJS, JSX, and modern syntax.
 *
 * Pass `filePath` so the parser can pick TS-vs-TSX-vs-JSX plugin combos correctly.
 * Without it, `.ts` files with type-cast syntax (`<Type>expr`) may misparse as JSX.
 */
export function parseJS(code: string, isModule: boolean = true, filePath?: string): File {
    return parse(code, {
        sourceType: isModule ? 'module' : 'script',
        plugins: pluginsFor(filePath),
        ranges: true,
        errorRecovery: true,
    });
}

/**
 * Attempt to determine if code is a module (has import/export) or script
 */
export function detectSourceType(code: string): 'module' | 'script' {
    if (/\b(import|export)\s/.test(code)) return 'module';
    return 'script';
}

/**
 * Parse code with auto-detected source type. Pass `filePath` for correct
 * plugin selection (.ts vs .tsx vs .jsx). Optional for backwards compat.
 */
export function parseJSAuto(code: string, filePath?: string): File {
    const sourceType = detectSourceType(code);
    return parseJS(code, sourceType === 'module', filePath);
}
