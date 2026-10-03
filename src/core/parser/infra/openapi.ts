/**
 * infra/openapi.ts — Issue #705 Phase 2 OpenAPI / Swagger parser.
 *
 * Extracts `paths.<route>.<method>` operations from OpenAPI v2 (Swagger)
 * or v3 spec files (YAML or JSON). Each operation becomes one
 * `openapi-route` record so downstream L2b api-list rendering can
 * surface the route's HTTP method, operationId, summary, and tags.
 *
 * Regex-based scan (no js-yaml or similar dependency). The spec format
 * is rigid enough that a thin parser covers the L2b need without
 * pulling in a multi-MB YAML lib:
 *   - JSON files use a brace-depth walk to find each `"paths"` object.
 *   - YAML files use indentation: top-level `paths:`, then 2-space
 *     route keys, then 4-space method keys.
 *
 * `canParse` matches `*.openapi.{yaml,yml,json}`, `*.swagger.{yaml,yml,json}`,
 * `openapi.{yaml,yml,json}`, `swagger.{yaml,yml,json}`, and `*.oas.json`.
 * Avoids matching generic YAML/JSON — those would over-trigger and hit
 * an early empty-return anyway.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

export function canParseOpenApi(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
        /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(lower) ||
        /\.(openapi|swagger|oas)\.(ya?ml|json)$/i.test(lower)
    );
}

interface Operation {
    method: string;
    route: string;
    operationId?: string;
    summary?: string;
    tags?: string[];
    lineIndex: number;
}

export function parseOpenApi(filePath: string, source: string): InfraRecord[] {
    const isJson = /\.json$/i.test(filePath);
    const ops = isJson ? extractJsonOperations(source) : extractYamlOperations(source);
    if (ops.length === 0) return [];

    const lines = source.split('\n');
    return ops.map(op => {
        const id = `infra:openapi-route:${filePath}::${op.method.toUpperCase()} ${op.route}`;
        const anchor: Anchor = {
            filePath,
            symbol: `${op.method.toUpperCase()} ${op.route}`,
            span: {
                start: charOffsetOfLine(lines, op.lineIndex),
                end: charOffsetOfLine(lines, op.lineIndex + 1),
            },
        };
        const meta: Record<string, unknown> = { method: op.method.toUpperCase(), route: op.route };
        if (op.operationId) meta.operationId = op.operationId;
        if (op.summary) meta.summary = op.summary;
        if (op.tags && op.tags.length > 0) meta.tags = op.tags;

        return {
            id,
            kind: 'openapi-route' as const,
            name: `${op.method.toUpperCase()} ${op.route}`,
            filePath,
            anchor,
            meta,
        };
    });
}

/**
 * YAML extraction — indentation-driven walk. The spec invariant:
 * top-level `paths:`, then route keys at +2 indent, then method keys
 * at +4 indent. Tolerate comments + blank lines.
 */
function extractYamlOperations(source: string): Operation[] {
    const lines = source.split('\n');
    const ops: Operation[] = [];

    let inPaths = false;
    let pathsIndent = -1;
    let currentRoute: string | null = null;
    let currentRouteIndent = -1;
    let currentMethod: string | null = null;
    let currentMethodIndent = -1;
    let currentOp: Operation | null = null;

    const stripComment = (s: string) => s.replace(/\s+#.*$/, '');

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        const line = stripComment(raw);

        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

        if (!inPaths) {
            if (/^paths\s*:\s*$/.test(line)) {
                inPaths = true;
                pathsIndent = indent;
            }
            continue;
        }

        // Exit the paths block when we hit a sibling top-level key.
        if (indent <= pathsIndent && line.trim().length > 0) {
            if (currentOp) ops.push(currentOp);
            return ops;
        }

        // Route key — starts with `/` and is a child of `paths:`.
        const routeMatch = /^(\s+)("([^"]+)"|'([^']+)'|(\/[^\s:]+))\s*:\s*$/.exec(line);
        if (routeMatch && (currentRouteIndent < 0 || routeMatch[1].length <= currentRouteIndent)) {
            if (currentOp) ops.push(currentOp);
            currentOp = null;
            currentMethod = null;
            currentMethodIndent = -1;
            currentRouteIndent = routeMatch[1].length;
            currentRoute = (routeMatch[3] ?? routeMatch[4] ?? routeMatch[5] ?? '').trim();
            continue;
        }

        // Method key — child of a route key.
        if (currentRoute) {
            const mm = /^(\s+)([A-Za-z]+)\s*:\s*$/.exec(line);
            if (mm && mm[1].length > currentRouteIndent && HTTP_METHODS.has(mm[2].toLowerCase())) {
                if (currentOp) ops.push(currentOp);
                currentMethod = mm[2].toLowerCase();
                currentMethodIndent = mm[1].length;
                currentOp = { method: currentMethod, route: currentRoute, lineIndex: i };
                continue;
            }
        }

        // Operation-level metadata (operationId, summary, tags).
        if (currentOp && indent > currentMethodIndent) {
            const opIdM = /^\s+operationId\s*:\s*"?([^"\n]+?)"?\s*$/.exec(line);
            if (opIdM) currentOp.operationId = opIdM[1].trim();
            const sumM = /^\s+summary\s*:\s*"?([^"\n]+?)"?\s*$/.exec(line);
            if (sumM) currentOp.summary = sumM[1].trim();
            const inlineTags = /^\s+tags\s*:\s*\[([^\]]*)\]/.exec(line);
            if (inlineTags) {
                currentOp.tags = inlineTags[1].split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
            }
        }
    }

    if (currentOp) ops.push(currentOp);
    return ops;
}

/**
 * JSON extraction — tokens are bracketed cleanly so we can spot the
 * `"paths"` key + its sibling map of routes. For each route value,
 * each child key whose name is an HTTP method becomes an operation.
 * Line index uses a fallback approach: track the offset of each match
 * via the source string indices and convert to a line number.
 */
function extractJsonOperations(source: string): Operation[] {
    const ops: Operation[] = [];
    let obj: unknown;
    try {
        obj = JSON.parse(source);
    } catch {
        return ops;
    }
    if (!obj || typeof obj !== 'object') return ops;
    const paths = (obj as { paths?: Record<string, Record<string, unknown>> }).paths;
    if (!paths || typeof paths !== 'object') return ops;

    for (const [route, methods] of Object.entries(paths)) {
        if (!methods || typeof methods !== 'object') continue;
        for (const [method, op] of Object.entries(methods)) {
            if (!HTTP_METHODS.has(method.toLowerCase())) continue;
            const entry: Operation = { method: method.toLowerCase(), route, lineIndex: 0 };
            if (op && typeof op === 'object') {
                const o = op as Record<string, unknown>;
                if (typeof o.operationId === 'string') entry.operationId = o.operationId;
                if (typeof o.summary === 'string') entry.summary = o.summary;
                if (Array.isArray(o.tags)) entry.tags = (o.tags as unknown[]).filter((t): t is string => typeof t === 'string');
            }
            ops.push(entry);
        }
    }
    return ops;
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1;
    return n;
}
