/**
 * serverlessFrameworkRouteExtractor.ts - UX-25 (2026-06-04)
 *
 * Parse Serverless Framework `serverless.yml` into the canonical
 * ApiRecord shape. Sister extractor to samRouteExtractor (UX-24) — both
 * cover the same gap (HTTP routes declared as YAML config that
 * CodeAtlas's framework detectors couldn't see).
 *
 * Supports:
 *   - `http:`      → REST API Gateway (v1). Both object form
 *                    (`{ path, method }`) and short-form string
 *                    (`"GET /hello"`).
 *   - `httpApi:`   → HTTP API Gateway (v2). Same shape as http:.
 *   - `websocket:` → WebSocket API. Method is synthetic 'WS'; the
 *                    route is the websocket route key ($connect / $default
 *                    / $disconnect / custom).
 *
 * Non-HTTP events (s3, sqs, schedule, sns, eventBridge, dynamodb, kinesis,
 * cognitoUserPool, alb, ...) are intentionally skipped — same scope decision
 * as samRouteExtractor.
 *
 * Multi-provider note: the YAML shape is identical across AWS / Azure /
 * GCP / Cloudflare / Knative. We don't read `provider.name` to gate
 * extraction — if a function has `events.- http:`, we emit a route
 * regardless of provider.
 */

import * as yaml from 'js-yaml';
import * as path from 'path';
import type { ApiRecord, Anchor } from '../graph/graphTypes';

// UX-25 gap 4 (2026-06-05) — serverless.yml's `resources:` and `iam.role.statements`
// blocks often use CloudFormation intrinsic tags (`!GetAtt`, `!Ref`, `!Sub`).
// Without a tolerant schema, `js-yaml` throws and the whole template's routes
// are dropped. Mirror samRouteExtractor's CFN_SCHEMA.
const CFN_INTRINSICS = [
    'Ref', 'Sub', 'GetAtt', 'Join', 'Split', 'Select', 'FindInMap',
    'Base64', 'Cidr', 'GetAZs', 'ImportValue', 'Transform', 'And', 'Or',
    'Not', 'Equals', 'If', 'Condition', 'ToJsonString', 'Length',
];
const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
    CFN_INTRINSICS.flatMap((name) => [
        new yaml.Type(`!${name}`, { kind: 'scalar', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'sequence', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'mapping', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
    ]),
);

/**
 * Returns true if the given path looks like a Serverless Framework
 * config file. Used by the dispatcher to route the file to this
 * extractor instead of treating it as a regular YAML file.
 */
export function isServerlessFrameworkPath(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    return base === 'serverless.yml' || base === 'serverless.yaml';
}

export function parseServerlessFrameworkTemplate(
    yamlText: string,
    templateFilePath: string,
): ApiRecord[] {
    if (!yamlText || !yamlText.trim()) return [];

    let doc: any;
    try {
        doc = yaml.load(yamlText, { schema: CFN_SCHEMA });
    } catch {
        return [];
    }
    if (!doc || typeof doc !== 'object') return [];

    const providerRuntime = String(((doc as any).provider ?? {}).runtime ?? '');
    const templateDir = path.dirname(templateFilePath);
    const records: ApiRecord[] = [];

    const functions = (doc as any).functions;
    if (functions && typeof functions === 'object') {
        for (const [fnName, fnDef] of Object.entries(functions)) {
            if (!fnDef || typeof fnDef !== 'object') continue;
            const fn = fnDef as any;
            const events = Array.isArray(fn.events) ? fn.events : [];
            if (events.length === 0) continue;

            const handlerString = String(fn.handler ?? '');
            const runtime = String(fn.runtime ?? providerRuntime ?? '');
            const handlerFilePath = resolveHandlerFilePath(templateDir, handlerString, runtime);

            let eventIndex = 0;
            for (const event of events) {
                const eventRecords = extractRouteFromEvent(event, fnName, handlerFilePath, eventIndex++);
                records.push(...eventRecords);
            }
        }
    }

    // UX-25 gap 5 (2026-06-05) — Step Functions HTTP triggers. The
    // serverless-step-functions plugin lets users declare an HTTP event
    // under stepFunctions.stateMachines.<name>.events.- http: that
    // proxies API Gateway → Step Functions. These are real HTTP routes
    // and should appear in L2b. Handler file path falls back to the
    // template directory since state machines don't have a single
    // source file.
    const stepFunctions = (doc as any).stepFunctions;
    if (stepFunctions && typeof stepFunctions === 'object') {
        const stateMachines = stepFunctions.stateMachines;
        if (stateMachines && typeof stateMachines === 'object') {
            for (const [smName, smDef] of Object.entries(stateMachines)) {
                if (!smDef || typeof smDef !== 'object') continue;
                const sm = smDef as any;
                const events = Array.isArray(sm.events) ? sm.events : [];
                if (events.length === 0) continue;
                // No per-machine handler file; use the template dir.
                const handlerFilePath = templateDir || '.';
                let eventIndex = 0;
                for (const event of events) {
                    const eventRecords = extractRouteFromEvent(event, smName, handlerFilePath, eventIndex++);
                    records.push(...eventRecords);
                }
            }
        }
    }

    return records;
}

function extractRouteFromEvent(
    event: any,
    fnName: string,
    handlerFilePath: string,
    eventIndex: number,
): ApiRecord[] {
    if (!event || typeof event !== 'object') return [];

    // The event YAML is `- http: ...` so the parsed shape is { http: ... }.
    // UX-25 gap 6 follow-up (2026-06-05) — some Azure templates put
    // `x-azure-settings:` at the SAME indent level as `http:` instead
    // of nested under it. In that shape the parsed event looks like
    // `{ http: null, 'x-azure-settings': {...} }`. Treat the sibling
    // settings as the effective http config.
    const sibling = event['x-azure-settings'];
    if ('http' in event) {
        let val = event.http;
        if (val == null && sibling && typeof sibling === 'object') {
            val = { 'x-azure-settings': sibling };
        }
        const parsed = parseHttpEvent(val, fnName);
        if (!parsed) return [];
        return [buildRecord(fnName, handlerFilePath, parsed.method, parsed.route, eventIndex, 'http')];
    }
    if ('httpApi' in event) {
        let val = event.httpApi;
        if (val == null && sibling && typeof sibling === 'object') {
            val = { 'x-azure-settings': sibling };
        }
        const parsed = parseHttpEvent(val, fnName);
        if (!parsed) return [];
        return [buildRecord(fnName, handlerFilePath, parsed.method, parsed.route, eventIndex, 'httpApi')];
    }
    if ('websocket' in event) {
        const ws = event.websocket;
        let route: string;
        if (typeof ws === 'string') {
            route = ws.startsWith('$') ? ws : `/${ws}`;
        } else if (ws && typeof ws === 'object') {
            const r = String(ws.route ?? ws.routeKey ?? '').trim();
            if (!r) return [];
            route = r.startsWith('$') ? r : `/${r}`;
        } else {
            return [];
        }
        return [buildRecord(fnName, handlerFilePath, 'WS', route, eventIndex, 'websocket')];
    }
    // s3, sqs, schedule, sns, eventBridge, dynamodb, kinesis, etc. — skipped.
    return [];
}

function parseHttpEvent(httpVal: any, fnName: string): { method: string; route: string } | null {
    if (httpVal == null) return null;

    // UX-25 gap 2 (2026-06-05) — Azure Functions short-form `http: true`.
    // No route declared; the function-name acts as the implicit route +
    // the method is ANY. The provider's HTTP trigger routes to a path
    // derived from the function name (configurable but defaults to
    // `/api/<functionName>`).
    if (httpVal === true) {
        return { method: 'ANY', route: `/${fnName}` };
    }

    if (typeof httpVal === 'string') {
        const trimmed = httpVal.trim();
        if (!trimmed) return null;
        // UX-25 gap 1 (2026-06-05) — wildcard / catch-all short-form
        // `http: "*"` / `httpApi: "*"`. ANY method, route is `/*` to
        // signal the wildcard nature in the L2b view.
        if (trimmed === '*' || trimmed === '$default') {
            return { method: 'ANY', route: '/*' };
        }
        // Standard "METHOD path" form.
        const twoToken = trimmed.match(/^(\S+)\s+(\S+)$/);
        if (twoToken) {
            const method = twoToken[1].toUpperCase();
            const rawPath = twoToken[2];
            const route = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
            return { method, route };
        }
        // UX-25 gap 3 (2026-06-05) — Google Cloud Functions single-word
        // path form: `http: path`. No method declared → default GET (GCF
        // HTTP triggers default to all methods; we pick GET as the
        // visible route).
        const oneToken = trimmed.match(/^(\S+)$/);
        if (oneToken) {
            const rawPath = oneToken[1];
            const route = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
            return { method: 'GET', route };
        }
        return null;
    }
    // Object form: { path, method } (some variants use `route` for path).
    if (typeof httpVal === 'object') {
        // UX-25 gap 6 (2026-06-05) — Azure x-azure-settings shape.
        // `serverless-azure-functions` nests the route/methods under
        // `x-azure-settings`. Unwrap that before falling through to the
        // standard path/method lookup.
        let v: any = httpVal;
        if (v && typeof v === 'object' && v['x-azure-settings'] && typeof v['x-azure-settings'] === 'object') {
            v = v['x-azure-settings'];
        }
        const rawPath = String(v.path ?? v.route ?? '').trim();
        // `methods:` array form (Azure): pick the first; if multiple
        // methods declared, the others are sibling routes — caller
        // emits multiple records via the array path below.
        const methodsArr = Array.isArray(v.methods) ? v.methods : null;
        const rawMethod = methodsArr && methodsArr.length > 0
            ? String(methodsArr[0]).trim()
            : String(v.method ?? '').trim();
        if (!rawPath || !rawMethod) return null;
        const method = rawMethod.toUpperCase();
        const route = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
        return { method, route };
    }
    return null;
}

function buildRecord(
    fnName: string,
    handlerFilePath: string,
    method: string,
    route: string,
    eventIndex: number,
    source: 'http' | 'httpApi' | 'websocket',
): ApiRecord {
    // 2026-06-09 — Issue: in multi-repo workspaces (e.g. serverless/examples
    // with 132 sub-projects all using the same `createUser`/`deleteUser`/etc.
    // naming), the workspace `apiIndex` deduplicates `sls:<fn>:<METHOD>:<path>`
    // across every sub-repo — 209 unique per-repo APIs collapse to 124 in the
    // workspace store. Lose count, lose MCP/impact visibility, mis-route L3
    // sequence drill-ins. Prefix the apiId with the handler file's top-level
    // directory so identical fnName+method+route in different sub-repos stay
    // distinct. For single-repo workspaces where the handler lives at the
    // workspace root, the prefix is empty and the legacy form is preserved.
    const norm = handlerFilePath.replace(/\\/g, '/');
    const firstSlash = norm.indexOf('/');
    const repoPrefix = firstSlash > 0 ? `${norm.slice(0, firstSlash)}:` : '';
    const apiId = `sls:${repoPrefix}${fnName}:${method}:${route}:${eventIndex}`;
    const anchor: Anchor = {
        filePath: handlerFilePath,
        lineStart: 1,
        lineEnd: 1,
    };
    return {
        apiId,
        method,
        route,
        handlerName: fnName,
        filePath: handlerFilePath,
        anchor,
        meta: {
            // Tag the source so downstream renderers can mark websocket
            // routes distinctly. The websocket protocol uses `WS` as the
            // synthetic method which renderers already understand (e.g.
            // the L2b "Real-Time" section).
        },
    } as ApiRecord;
}

function resolveHandlerFilePath(
    templateDir: string,
    handler: string,
    runtime: string,
): string {
    if (!handler) {
        return path.join(templateDir, 'handler.js');
    }
    const ext = extensionForRuntime(runtime);

    // Java handler `com.example.App::handleRequest` → `com/example/App.java`
    if (ext === '.java' || /^java/i.test(runtime)) {
        const beforeColon = handler.split('::')[0];
        const dotted = beforeColon.split('.');
        const className = dotted.pop();
        return path.join(templateDir, ...dotted, `${className}.java`);
    }
    if (/^dotnet/i.test(runtime)) {
        // #810 (2026-06-10) — canonical handler shape is
        // `<assembly>::<assembly.namespace.Class>::<method>` (3 parts) or
        // `<namespace.Class>::<method>` (2 parts). Treat the part before
        // the last `::` as the fully-qualified type name; split on `.`,
        // pop the class to get the filename, then strip any leading
        // segments shared with the assembly prefix so the residual
        // segments form the directory path under templateDir.
        const parts = handler.split('::');
        const fqType = parts.length >= 3 ? parts[1] : parts[0];
        const dotted = (fqType ?? '').split('.').filter(Boolean);
        const klass = dotted.pop() ?? 'Handler';
        if (parts.length >= 3) {
            const assembly = (parts[0] ?? '').split('.').filter(Boolean);
            while (assembly.length && dotted.length && dotted[0] === assembly[0]) {
                dotted.shift();
                assembly.shift();
            }
        }
        return path.join(templateDir, ...dotted, `${klass}.cs`);
    }
    if (ext === '.go') {
        // Go: handler is typically `main` or `bootstrap`.
        return path.join(templateDir, 'main.go');
    }

    // Node/Python/Ruby: handler is `path/to/file.exportName` → strip the export.
    const fileStem = handler.split('.').slice(0, -1).join('.') || handler;
    return path.join(templateDir, `${fileStem}${ext}`);
}

function extensionForRuntime(runtime: string): string {
    const r = runtime.toLowerCase();
    if (r.startsWith('python')) return '.py';
    if (r.startsWith('go')) return '.go';
    if (r.startsWith('java')) return '.java';
    if (r.startsWith('dotnet')) return '.cs';
    if (r.startsWith('ruby')) return '.rb';
    if (r.startsWith('provided')) return '.sh';
    return '.js';
}
