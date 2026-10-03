/**
 * goHandlerAnchor.ts — TICKET-DETECT-3 (go-fiber / gin / echo / chi).
 *
 * Go router registrations declare the route and the handler in different files:
 *
 *     // hexagonal/main.go
 *     r.Get("/products/{code}", handler.Get)   // handler defined in hexagonal/api/http.go
 *
 * The detector captures the BARE handler name (`Get`) and anchors the entry
 * point to the ROUTER file (`main.go` / `router.go`), so the endpoint's L3/L4/L5
 * and its review pack target the route-registration file, not the code that
 * actually handles the request.
 *
 * This snapshot-level pass re-anchors such routes onto the file that DEFINES the
 * handler — but only when resolution is UNAMBIGUOUS. Go handler names recur
 * across a multi-app repo (`Hello` is defined in six sub-apps of the go-fiber
 * samples), so a naive by-name match would mis-anchor. We resolve by NEAREST
 * PATH: pick the defining file that shares the longest leading path prefix with
 * the router file, and only re-anchor when that nearest match is UNIQUE. Within
 * a sub-app the handler is unique; across sub-apps the shared prefix is shorter,
 * so the same-sub-app handler always wins — and a genuine tie leaves the entry
 * untouched (never a wrong anchor).
 *
 * Like the Rails/Django anchor passes it is pure, count-preserving, and
 * baseline/working-symmetric (deterministic for a given snapshot → no diff churn).
 */

import type { ApiRecord } from '../graph/graphTypes';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Bare name = the part after the last '.' (strips a `recv.`/`pkg.` prefix). */
function bare(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? name : name.slice(dot + 1);
}

/** Number of leading path segments two files share (directory closeness). */
function sharedPrefixSegments(a: string, b: string): number {
    const as = a.split('/');
    const bs = b.split('/');
    let n = 0;
    // Compare directory segments only (exclude the filename at the tail).
    const max = Math.min(as.length - 1, bs.length - 1);
    while (n < max && as[n] === bs[n]) n++;
    return n;
}

interface FileSymbols { symbols?: { functions?: Array<{ name?: string }> } }

export function resolveGoHandlerAnchors(
    apiIndex: Record<string, ApiRecord>,
    files: Record<string, FileSymbols>,
): Record<string, ApiRecord> {
    // Build bareName → [{file, name}] over Go function/method definitions.
    // Bail fast on non-Go workspaces.
    const defsByBare = new Map<string, Array<{ file: string; name: string }>>();
    let hasGo = false;
    for (const [file, rec] of Object.entries(files)) {
        if (!file.endsWith('.go')) continue;
        hasGo = true;
        for (const fn of rec.symbols?.functions ?? []) {
            const name = fn.name;
            if (!name) continue;
            const key = bare(name);
            const arr = defsByBare.get(key) ?? [];
            arr.push({ file, name });
            defsByBare.set(key, arr);
        }
    }
    if (!hasGo) return apiIndex;

    let changed = false;
    const out: Record<string, ApiRecord> = {};
    for (const [key, rec] of Object.entries(apiIndex)) {
        const reanchored = tryReanchor(rec, defsByBare);
        if (reanchored) {
            out[reanchored.apiId] = reanchored;
            changed = true;
        } else {
            out[key] = rec;
        }
    }
    return changed ? out : apiIndex;
}

function tryReanchor(
    rec: ApiRecord,
    defsByBare: Map<string, Array<{ file: string; name: string }>>,
): ApiRecord | null {
    if (!rec.filePath?.endsWith('.go')) return null;
    if (!HTTP_METHODS.has(rec.method)) return null;
    const handler = rec.handlerName;
    // Plain identifier only — skip anonymous closures / synthetic names.
    if (!handler || handler.startsWith('anonymous@') || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(handler)) return null;

    const candidates = (defsByBare.get(bare(handler)) ?? []).filter((c) => c.file !== rec.filePath);
    if (candidates.length === 0) return null;

    // Nearest by shared directory prefix; re-anchor only on a UNIQUE winner.
    let bestLen = -1;
    let best: { file: string; name: string } | undefined;
    let tie = false;
    for (const c of candidates) {
        const len = sharedPrefixSegments(rec.filePath, c.file);
        if (len > bestLen) { bestLen = len; best = c; tie = false; }
        else if (len === bestLen) { tie = true; }
    }
    if (!best || tie) return null;

    return {
        ...rec,
        apiId: `${rec.method}:${rec.route}::${best.file}::${rec.handlerName}`,
        filePath: best.file,
        anchor: { ...(rec.anchor ?? {}), filePath: best.file, symbol: rec.handlerName, span: undefined, lineStart: undefined, lineEnd: undefined },
        meta: {
            ...(rec.meta ?? {}),
            routeDeclFile: rec.filePath, // keep where the route was registered
        },
    };
}
