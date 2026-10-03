/**
 * cdkConstructExtractor.ts — UX-26 (2026-06-05)
 *
 * AWS CDK declares HTTP routes in TypeScript/Python code via construct
 * chains. Two dominant shapes:
 *
 *   1. **REST API v1** (`@aws-cdk/aws-apigateway`):
 *        api.root.addResource('users').addMethod('GET', integration);
 *        const r = api.root.addResource('users');
 *        r.addMethod('POST', integration);
 *      Path is built by walking the addResource chain. Method is the
 *      first string arg of addMethod.
 *
 *   2. **HTTP API v2** (`@aws-cdk/aws-apigatewayv2`):
 *        httpApi.addRoutes({
 *          path: '/protected',
 *          methods: [HttpMethod.GET, HttpMethod.POST],
 *          integration: new HttpLambdaIntegration(...),
 *        });
 *      Path + methods are properties on the options object.
 *
 * Python equivalents use snake_case (`add_resource`, `add_method`,
 * `add_routes`) and keyword args.
 *
 * Regex-based extraction — CDK ASTs are too costly to traverse for
 * what's effectively a string-shape match. Returns `[]` on any
 * non-CDK file. Wired into the IaC scan path in
 * `syncOrchestrator.scanIacTemplates`.
 */

import * as path from 'path';
import type { ApiRecord, Anchor } from '../graph/graphTypes';

/**
 * Fast probe: does the source LOOK like CDK code? Checks for the
 * `aws-cdk-lib` / `@aws-cdk/*` (TS) or `aws_cdk` (Python) imports.
 * Used by callers to gate before running the heavier parser.
 */
export function isCdkLikely(source: string): boolean {
    if (!source) return false;
    if (/(?:from|import)\s+['"](?:aws-cdk-lib|@aws-cdk\/)/.test(source)) return true;
    if (/from\s+aws_cdk\b/.test(source)) return true;
    // UX-26 Phase 2 (2026-06-05) — Java CDK imports.
    if (/\bimport\s+software\.amazon\.awscdk\b/.test(source)) return true;
    // UX-26 Phase 4 (2026-06-05) — API-usage detection for child stacks
    // in multi-file projects that import `RestApi` / `HttpApi` via a
    // relative path (not directly from aws-cdk-lib). Match files that
    // BOTH mention a CDK construct type AND use its method API.
    const hasCdkType = /\b(?:RestApi|HttpApi|LambdaIntegration|HttpLambdaIntegration|HttpMethod|Resource)\b/.test(source);
    const usesCdkApi = /\.\s*(?:addResource|addMethod|addRoutes|getRoot)\s*\(/.test(source)
        || /\.\s*(?:add_resource|add_method|add_routes)\s*\(/.test(source);
    if (hasCdkType && usesCdkApi) return true;
    return false;
}

/**
 * Parse CDK construct chains. Returns one ApiRecord per (method, path)
 * combination. Anchor lives at the matching declaration in `filePath`.
 */
export function parseCdkConstructs(source: string, filePath: string): ApiRecord[] {
    if (!isCdkLikely(source)) return [];

    const out: ApiRecord[] = [];
    let counter = 0;
    const makeRecord = (method: string, route: string, handlerName: string, offset: number): ApiRecord => {
        const apiId = `cdk:${filePath}:${method}:${route}:${counter++}`;
        const anchor: Anchor = {
            filePath,
            symbol: handlerName,
            span: { start: offset, end: offset + 1 },
        };
        return {
            apiId,
            method,
            route,
            handlerName,
            filePath,
            anchor,
            meta: { /* tag-source could go here in a follow-up */ },
        } as ApiRecord;
    };

    parseV1RestChain(source, filePath, makeRecord, out);
    parseV2AddRoutes(source, filePath, makeRecord, out);
    return out;
}

/**
 * REST API v1 (apigateway). Two passes:
 *   1. Build a map of resource-variable → full path by walking every
 *      `<var>.addResource('seg')` and `<var>.root.addResource('seg')`
 *      declaration. Detects multi-level chains via repeated
 *      `<child> = <parent>.addResource('child')`.
 *   2. For every `<var>.addMethod('METHOD', ...)`, emit a record at
 *      the resolved path.
 *
 * Anonymous chains (`api.root.addResource('users').addMethod('GET', ...)`)
 * are handled inline — the addResource arg becomes the path.
 *
 * Python `add_resource` / `add_method` are handled by the same regex
 * since the only difference is snake_case which we accept as a verb
 * alias.
 */
function parseV1RestChain(
    source: string,
    _filePath: string,
    makeRecord: (m: string, r: string, h: string, off: number) => ApiRecord,
    out: ApiRecord[],
): void {
    // 1a. Resource-variable assignments. Capture variable name + path segment.
    //    Patterns matched:
    //      const X = api.root.addResource('seg');
    //      const X = parent.addResource('seg');
    //      X = api.root.add_resource("seg")           (Python)
    //      X = parent.add_resource("seg")
    //
    //    For chained `.addResource('a').addResource('b')` we record both
    //    in sequence; the second walks back to find the LHS variable's
    //    parent path.
    // UX-26 Phase 2 (2026-06-05) — also accept Java's typed-decl syntax
    // (`Resource items = api.getRoot().addResource("items")`) by allowing
    // an optional Java type identifier before the variable name.
    // UX-26 Phase 4 (2026-06-05) — also accept TS-style type annotations
    // on the LHS (`const users: Resource = ...`). Optional segment matches
    // `:` + a type expression (`Resource`, `IResource`, `Resource | null`,
    // `Promise<Resource>`, etc.) up to but not including the `=`.
    const RESOURCE_DECL_RE = /(?:const|let|var|[A-Z]\w*\s+)?\s*(\w+)(?:\s*:\s*[\w<>\[\]|&,\s.]+?)?\s*=\s*([\w.()]+?)\s*\.\s*(?:add[Rr]esource|add_resource)\s*\(\s*['"]([^'"]+)['"]/g;
    // Java CDK exposes root as `getRoot()` rather than `.root`. Accept both.
    const ROOT_RE = /\.\s*(?:root|getRoot\s*\(\s*\))\s*$/;
    const resourcePaths = new Map<string, string>(); // varName → /full/path
    let m: RegExpExecArray | null;
    while ((m = RESOURCE_DECL_RE.exec(source)) !== null) {
        const varName = m[1];
        const parent = m[2];
        const segment = m[3];
        let parentPath = '';
        if (ROOT_RE.test(parent)) {
            // api.root → path starts here. Drop the api prefix.
            parentPath = '';
        } else {
            // Look up the parent variable's path.
            parentPath = resourcePaths.get(parent) ?? '';
        }
        const fullPath = parentPath + '/' + segment;
        resourcePaths.set(varName, fullPath);
    }

    // 1b. Inline chain: api.root.addResource('users').addMethod('GET', ...)
    //    Emitted directly as a route — no variable to track.
    // UX-26 Phase 2 (2026-06-05) — also handle `api.getRoot().addMethod(...)`
    // standalone (without addResource in between). For Java CDK,
    // `api.getRoot().addMethod("GET", integration)` is the canonical
    // pattern for the `/` route. Match it as the inline chain.
    const INLINE_CHAIN_RE = /([\w.]+)\s*\.\s*(?:add[Rr]esource|add_resource)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(?:add[Mm]ethod|add_method)\s*\(\s*['"]([A-Z]+)['"]/g;
    const ROOT_INLINE_METHOD_RE = /(\w+)\s*\.\s*(?:root|getRoot\s*\(\s*\))\s*\.\s*(?:add[Mm]ethod|add_method)\s*\(\s*['"]([A-Z]+)['"]/g;
    while ((m = INLINE_CHAIN_RE.exec(source)) !== null) {
        const parent = m[1];
        const segment = m[2];
        const method = m[3].toUpperCase();
        let parentPath = '';
        if (!ROOT_RE.test(parent)) {
            parentPath = resourcePaths.get(parent) ?? '';
        }
        const route = parentPath + '/' + segment;
        out.push(makeRecord(method, route, segment, m.index));
    }

    // UX-26 Phase 2 (2026-06-05) — Java CDK `api.getRoot().addMethod(...)`
    // pattern emits a route on the root path. The TS equivalent
    // `api.root.addMethod(...)` is rare but also matched here.
    ROOT_INLINE_METHOD_RE.lastIndex = 0;
    while ((m = ROOT_INLINE_METHOD_RE.exec(source)) !== null) {
        const method = m[2].toUpperCase();
        out.push(makeRecord(method, '/', 'root', m.index));
    }

    // 2. addMethod calls on resource variables.
    const ADD_METHOD_RE = /(\w+)\s*\.\s*(?:add[Mm]ethod|add_method)\s*\(\s*['"]([A-Z]+)['"]/g;
    while ((m = ADD_METHOD_RE.exec(source)) !== null) {
        const varName = m[1];
        const method = m[2].toUpperCase();
        // Skip when this match was already emitted as part of an inline chain
        // (the inline chain anchors at the START of `parent.addResource`,
        // and the regex above sees the addMethod token AT a later offset
        // inside the same chain). Defensive: skip if the offset lies inside
        // a previously emitted inline chain by checking duplicates.
        const route = resourcePaths.get(varName);
        if (route === undefined) continue;
        // The inline-chain regex catches the SAME addMethod token when
        // present (because `api.root.addResource('users').addMethod('GET'`
        // matches both regexes — varName captured would be the dotted
        // expression `api.root` here, which is NOT in resourcePaths, so
        // this branch is skipped). The two regexes are non-overlapping
        // in practice.
        out.push(makeRecord(method, route, varName, m.index));
    }
}

/**
 * HTTP API v2 (apigatewayv2). Pattern:
 *   <api>.addRoutes({ path: '...', methods: [...], integration: ... });
 *   <api>.add_routes(path="...", methods=[...], integration=...)    (Python)
 *
 * Extracts path + every method in the methods array. `HttpMethod.GET`
 * tokens are normalised by taking the last `.`-segment.
 */
function parseV2AddRoutes(
    source: string,
    _filePath: string,
    makeRecord: (m: string, r: string, h: string, off: number) => ApiRecord,
    out: ApiRecord[],
): void {
    // Match `<var>.addRoutes(` — walk balancing parens to find the matching
    // `)`. The body may include nested braces / parens (e.g. an
    // `integration: new X(...)` member or a Python kwarg list); we only
    // count `(` / `)` to find the outermost call boundary.
    const ADD_ROUTES_RE = /(\w+)\s*\.\s*(?:addRoutes|add_routes)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = ADD_ROUTES_RE.exec(source)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < source.length && depth > 0) {
            const ch = source[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            i++;
        }
        const body = source.slice(m.index + m[0].length, i - 1);
        // Path: TS `path: '/foo'` or Python `path="/foo"`.
        const pathMatch = body.match(/\bpath\s*[:=]\s*['"]([^'"]+)['"]/);
        if (!pathMatch) continue;
        const route = pathMatch[1];
        // Methods array: TS `methods: [HttpMethod.GET, ...]` or Python `methods=[...]`.
        const methodsMatch = body.match(/\bmethods\s*[:=]\s*\[([^\]]*)\]/);
        if (!methodsMatch) continue;
        const methodTokens = [...methodsMatch[1].matchAll(/['"]?([\w.]+)['"]?/g)].map((mm) => mm[1]);
        const methods = methodTokens
            .map((t) => (t.includes('.') ? t.split('.').pop()! : t).toUpperCase())
            .filter((t) => /^[A-Z]+$/.test(t));
        if (methods.length === 0) continue;
        for (const method of methods) {
            out.push(makeRecord(method, route, route, m.index));
        }
    }
}

/**
 * Convenience predicate for the IaC scanner: should this file be
 * scanned for CDK constructs? Same probe as `isCdkLikely` but takes
 * a file name + content for symmetry with the YAML extractors.
 */
export function isCdkPath(filePath: string, content?: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.ts' && ext !== '.js' && ext !== '.py') return false;
    if (typeof content === 'string') return isCdkLikely(content);
    return false;
}
