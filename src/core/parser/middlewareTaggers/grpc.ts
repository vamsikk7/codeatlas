/**
 * middlewareTaggers/grpc.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-42 (2026-06-05) — gRPC interceptors cross-language.
 *
 * Three recognised forms:
 *
 *   1. **Object-literal interceptors list** (Node / Python):
 *        `new grpc.Server({ interceptors: [a, b] })`
 *        `grpc.server(pool, interceptors=[A(), B()])`
 *      Match `interceptors\s*[:=]\s*\[<args>\]` — accepts both `:` (Node
 *      object property) and `=` (Python kwarg).
 *
 *   2. **Go gRPC server options**:
 *        `grpc.UnaryInterceptor(a)` / `grpc.StreamInterceptor(s)`
 *        `grpc.ChainUnaryInterceptor(a, b, c)` / `grpc.ChainStreamInterceptor(...)`
 *      Match the full call, parse comma-separated args.
 *
 *   3. **Java `ServerInterceptors.intercept`**:
 *        `ServerInterceptors.intercept(svc, AuthInterceptor.INSTANCE, LogInterceptor)`
 *      First arg is the service; the rest are interceptors.
 *
 * Argument normalization: `Foo()` → `Foo`; `pkg.Foo` → `pkg.Foo`;
 * `Foo.INSTANCE` → `Foo`; closures / lambdas skipped.
 */
const GRPC_INTERCEPTORS_LIST_RE = /\binterceptors\s*[:=]\s*\[([^\]]*)\]/g;
const GRPC_GO_INTERCEPTOR_RE = /\bgrpc\s*\.\s*(?:Chain)?(?:Unary|Stream)Interceptor\s*\(([^)]*)\)/g;
const GRPC_JAVA_INTERCEPT_RE = /\bServerInterceptors\s*\.\s*intercept\s*\(\s*[^,]+\s*,([^)]*)\)/g;

export function tagGrpcInterceptors(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;
    // Only consider gRPC-shaped routes in this file.
    const grpcRoutes = apis.filter(a => a.method === 'GRPC' || a.method === 'RPC');
    if (grpcRoutes.length === 0) return;

    const interceptors: string[] = [];
    const collect = (re: RegExp) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const names = parseGrpcInterceptorArgs(m[1]);
            for (const n of names) if (!interceptors.includes(n)) interceptors.push(n);
        }
    };
    collect(GRPC_INTERCEPTORS_LIST_RE);
    collect(GRPC_GO_INTERCEPTOR_RE);
    collect(GRPC_JAVA_INTERCEPT_RE);

    if (interceptors.length === 0) return;

    for (const api of grpcRoutes) {
        api.meta = api.meta ?? {};
        const existing = api.meta.middlewares ?? [];
        const out = [...interceptors];
        for (const mw of existing) if (!out.includes(mw)) out.push(mw);
        api.meta.middlewares = out;
        // Auth derivation when an interceptor name is auth-shaped.
        if (!api.meta.auth) {
            for (const n of interceptors) {
                if (/(?:Auth|Jwt|Bearer|RequireAuth|OAuth|Session)/i.test(n)) {
                    api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

export function parseGrpcInterceptorArgs(argsRaw: string): string[] {
    if (!argsRaw) return [];
    const parts = argsRaw.split(',').map(p => p.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
        if (/^\s*(?:function|\(|\w+\s*=>|func\s*\(|lambda\b)/.test(p)) continue;
        let token = p;
        // Drop trailing call args.
        const parenIdx = token.indexOf('(');
        if (parenIdx >= 0) token = token.slice(0, parenIdx);
        // Drop trailing member access (`Foo.INSTANCE` → `Foo`).
        token = token.split('.')[0].trim();
        // Strip Python kwarg leading (`interceptors=AuthInterceptor()` is unlikely
        // but defensive — already eaten by split above).
        token = token.replace(/^\s*=\s*/, '').trim();
        if (!/^[A-Za-z_][\w]*$/.test(token)) continue;
        if (!out.includes(token)) out.push(token);
    }
    return out;
}

