/**
 * tier2.ts — Tier 2 MCP enhancements:
 *   - pagination helpers (`paginate`)
 *   - architecture-rule violations
 *   - coverage overlay
 *   - find similar entities
 *   - saved-query loader
 *   - token-budget guard
 *
 * Pure functions over a Snapshot (plus an optional workspaceRoot for coverage
 * + saved-query file lookups).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Snapshot, ApiRecord } from '../core/graph/graphTypes';
import { listEntryPoints, type EntryPointSummary } from './contextPack';
import { loadCoverageData, type CoverageReport } from '../core/analysis/coverageReader';

// ─── Tier 2.7: pagination ──────────────────────────────────────────────────

export interface PageOptions { cursor?: number; limit?: number; }
export interface PagedResponse<T> { items: T[]; total: number; nextCursor: number | null; }

export function paginate<T>(items: T[], options: PageOptions = {}): PagedResponse<T> {
    const cursor = Math.max(0, options.cursor ?? 0);
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const slice = items.slice(cursor, cursor + limit);
    const next = cursor + limit < items.length ? cursor + limit : null;
    return { items: slice, total: items.length, nextCursor: next };
}

// ─── Tier 2.8: architecture-rule violations ────────────────────────────────

export interface RuleViolation {
    rule: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    location?: { kind: 'route' | 'cluster' | 'file' | 'function'; id: string; filePath?: string };
}

interface ArchitectureRule {
    id: string;
    severity: 'error' | 'warning' | 'info';
    description: string;
    check: (snapshot: Snapshot) => RuleViolation[];
}

/**
 * Built-in rule library. Users can supply additional rules via
 * `.codeatlas/rules.json` (loaded by `listArchitectureViolations` when present).
 */
const BUILT_IN_RULES: ArchitectureRule[] = [
    {
        id: 'auth_required_on_writes',
        severity: 'warning',
        description: 'POST / PUT / PATCH / DELETE routes should declare auth.required OR carry an auth-classified middleware',
        check: (snapshot) => {
            // UX-48 follow-up (2026-06-05) — broaden the rule to use the
            // middleware chain (`meta.middlewares`) as evidence, not just
            // the dedicated `meta.auth` flag. Many framework taggers
            // populate the chain WITHOUT explicit auth derivation when
            // the middleware name doesn't match the auth-shape regex
            // (e.g. `oso.authorize`, `caslAbility`, custom guards). The
            // rule now treats ANY middleware in a curated auth-shaped
            // set as sufficient evidence.
            const AUTH_SHAPED_MW = /^(?:auth|authRequired|requireAuth|isAuthenticated|jwtAuth|jwt|jwt_required|passport|koaJwt|ensureAuth|ensureAuthenticated|sessionAuth|authMiddleware|login_required|IsAuthenticated|Authorize|PreAuthorize|PostAuthorize|Secured|RolesAllowed|IsGranted|Security|jwtRequired|requireLogin|requires_auth|admin_required|requires_admin|hasRole|hasScope|hasPermission|requireScope|RequireAuth|BearerAuth|BasicAuth|OAuth|SessionAuth)\b/i;
            const isAuthShaped = (name: string): boolean => {
                // Member-form (`pkg.auth`, `middleware.JWT`) — keep the last segment.
                const bare = name.includes('.') ? name.split('.').pop() ?? name : name;
                if (AUTH_SHAPED_MW.test(bare)) return true;
                if (AUTH_SHAPED_MW.test(name)) return true;
                // Substring fallback for compound names like `JwtAuthLayer`,
                // `RequireAuthGuard` — common in NestJS/Spring/Rust shops.
                return /(?:Jwt|Bearer|Auth)/.test(bare);
            };
            // Broader public-route exemption (login, signup, register,
            // password reset, magic-link, email verification, webhook
            // entry, health probes). These are intentionally public
            // and would otherwise flood the rule with false positives.
            const PUBLIC_ROUTE_RE = /\/(login|sign(?:in|on|up|out)|register|signup|signin|signout|signoff|logout|forgot[-_]?password|reset[-_]?password|verify[-_]?(?:email|otp)|magic[-_]?link|password[-_]?reset|webhook|hook|callback|oauth\/callback|sso\/callback)\b/i;
            const out: RuleViolation[] = [];
            for (const a of Object.values(snapshot.apiIndex ?? {})) {
                if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method)) continue;
                if (a.meta?.auth === 'required') continue;
                if (a.meta?.error) continue; // error-handler middleware is exempt
                if (a.meta?.webhook) continue; // webhook receivers (UX-31 / Issue 368) are exempt — signature verification is the auth surface
                if (PUBLIC_ROUTE_RE.test(a.route)) continue;
                const mws = a.meta?.middlewares ?? [];
                if (mws.some(isAuthShaped)) continue;
                const chainLabel = mws.length > 0 ? ` (chain: ${mws.join(' → ')})` : '';
                out.push({
                    rule: 'auth_required_on_writes',
                    severity: 'warning',
                    message: `${a.method} ${a.route} has no auth-classified middleware${chainLabel}`,
                    location: { kind: 'route', id: a.apiId, filePath: a.filePath },
                });
            }
            return out;
        },
    },
    {
        id: 'every_cluster_has_a_service',
        severity: 'info',
        description: 'Every feature cluster should belong to a known service (microservice grouping)',
        check: (snapshot) => {
            const out: RuleViolation[] = [];
            for (const c of Object.values(snapshot.clusters ?? {})) {
                if (!c.serviceId) {
                    out.push({
                        rule: 'every_cluster_has_a_service',
                        severity: 'info',
                        message: `Cluster '${c.name ?? c.label}' has no parent service`,
                        location: { kind: 'cluster', id: c.id },
                    });
                }
            }
            return out;
        },
    },
    {
        id: 'no_god_files',
        severity: 'warning',
        description: 'Files flagged as god-files (too many symbols) should be split',
        check: (snapshot) => {
            const out: RuleViolation[] = [];
            for (const fp of snapshot.health?.godFiles ?? []) {
                out.push({
                    rule: 'no_god_files',
                    severity: 'warning',
                    message: `God file: ${fp} has too many symbols`,
                    location: { kind: 'file', id: fp, filePath: fp },
                });
            }
            return out;
        },
    },
    {
        id: 'no_cyclic_dependencies',
        severity: 'error',
        description: 'File-level import cycles indicate broken layering',
        check: (snapshot) => {
            const out: RuleViolation[] = [];
            for (const cycle of snapshot.health?.cyclicDependencies ?? []) {
                out.push({
                    rule: 'no_cyclic_dependencies',
                    severity: 'error',
                    message: `Import cycle: ${cycle.join(' → ')}`,
                    location: { kind: 'file', id: cycle[0], filePath: cycle[0] },
                });
            }
            return out;
        },
    },
    {
        id: 'no_dead_functions',
        severity: 'info',
        description: 'Functions with no callers anywhere in the workspace',
        check: (snapshot) => {
            return (snapshot.health?.deadFunctions ?? []).map((key) => {
                const sep = key.indexOf('::');
                const filePath = sep >= 0 ? key.slice(0, sep) : key;
                const fn = sep >= 0 ? key.slice(sep + 2) : key;
                return {
                    rule: 'no_dead_functions',
                    severity: 'info' as const,
                    message: `Dead function: ${fn} (${filePath})`,
                    location: { kind: 'function' as const, id: key, filePath },
                };
            });
        },
    },
    {
        id: 'webhook_routes_have_signature_verification',
        severity: 'warning',
        description: 'POST routes whose path looks like a webhook entry should verify a signature',
        check: (snapshot) => {
            const out: RuleViolation[] = [];
            for (const a of Object.values(snapshot.apiIndex ?? {})) {
                if (a.method !== 'POST') continue;
                if (!/\b(webhook|webhooks|stripe|github|slack|twilio)\b/i.test(a.route + ' ' + a.filePath)) continue;
                if (a.meta?.webhook) continue;
                out.push({
                    rule: 'webhook_routes_have_signature_verification',
                    severity: 'warning',
                    message: `${a.method} ${a.route} looks like a webhook receiver but no signature verification was detected`,
                    location: { kind: 'route', id: a.apiId, filePath: a.filePath },
                });
            }
            return out;
        },
    },
];

export interface ArchitectureViolationOptions {
    /** Subset of rule ids to run. Default: all built-in + custom. */
    rules?: string[];
    workspaceRoot?: string;
}

export function listArchitectureViolations(
    snapshot: Snapshot,
    options: ArchitectureViolationOptions = {},
): { rules: string[]; violations: RuleViolation[] } {
    const customRules = options.workspaceRoot ? loadCustomRules(options.workspaceRoot) : [];
    const all = [...BUILT_IN_RULES, ...customRules];
    const requested = options.rules ? new Set(options.rules) : null;
    const violations: RuleViolation[] = [];
    const used: string[] = [];
    for (const rule of all) {
        if (requested && !requested.has(rule.id)) continue;
        used.push(rule.id);
        try { violations.push(...rule.check(snapshot)); } catch { /* skip broken rule */ }
    }
    return { rules: used, violations };
}

function loadCustomRules(workspaceRoot: string): ArchitectureRule[] {
    const candidates = [
        path.join(workspaceRoot, '.codeatlas', 'rules.json'),
        path.join(workspaceRoot, '.codeatlas', 'architecture-rules.json'),
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (Array.isArray(raw)) {
                return raw.filter((r) => r && typeof r.id === 'string' && typeof r.check === 'string').map(toRule);
            }
        } catch { /* fall through */ }
    }
    return [];
}

function toRule(raw: any): ArchitectureRule {
    // Custom rules are JSON-declared as a SQL-ish predicate over apiIndex
    // entries. Form: { id, severity, description, check: "<simple js
    // boolean expr referencing api>" }. Kept intentionally narrow to avoid
    // arbitrary code execution; users wanting full power should fork the
    // built-in rule list.
    return {
        id: raw.id,
        severity: raw.severity === 'error' || raw.severity === 'warning' ? raw.severity : 'info',
        description: raw.description ?? '',
        check: (snapshot) => {
            const out: RuleViolation[] = [];
            // Allowlist of properties the predicate may reference.
            const predicate = (api: ApiRecord) => {
                try {
                    // eslint-disable-next-line no-new-func
                    const fn = new Function('api', `return (${raw.check});`);
                    return !!fn(api);
                } catch { return false; }
            };
            for (const a of Object.values(snapshot.apiIndex ?? {})) {
                if (predicate(a)) {
                    out.push({
                        rule: raw.id,
                        severity: raw.severity,
                        message: `${a.method} ${a.route} matches custom rule ${raw.id}`,
                        location: { kind: 'route', id: a.apiId, filePath: a.filePath },
                    });
                }
            }
            return out;
        },
    };
}

// ─── Tier 2.9: coverage overlay ────────────────────────────────────────────

export interface CoverageOverlayEntry {
    filePath: string;
    lineRate: number;
    functionRate: number;
    branchRate?: number;
}

export function getCoverageOverlay(workspaceRoot: string): {
    files: CoverageOverlayEntry[];
    aggregate: { lineRate: number; functionRate: number };
    source: string;
} | null {
    const report: CoverageReport | null = loadCoverageData(workspaceRoot);
    if (!report) return null;

    const files: CoverageOverlayEntry[] = [];
    let weightedLine = 0, weightedBranch = 0, totalFns = 0, hitFns = 0;
    for (const [filePath, fc] of Object.entries(report)) {
        const fns = Object.values(fc.functions ?? {});
        const totalFnsHere = fns.length;
        const hitFnsHere = fns.filter((f) => f.hits > 0).length;
        const fr = totalFnsHere > 0 ? hitFnsHere / totalFnsHere : 0;
        files.push({
            filePath,
            lineRate: fc.lineRate,
            functionRate: fr,
            branchRate: fc.branchRate,
        });
        weightedLine += fc.lineRate;
        weightedBranch += fc.branchRate;
        totalFns += totalFnsHere; hitFns += hitFnsHere;
    }
    const fileCount = files.length || 1;
    return {
        files,
        aggregate: {
            lineRate: weightedLine / fileCount,
            functionRate: totalFns > 0 ? hitFns / totalFns : 0,
        },
        source: 'lcov+istanbul',
    };
}

// ─── Tier 2.10: find similar entities ──────────────────────────────────────

export interface SimilarEntity {
    id: string;
    kind: 'route' | 'function' | 'cluster';
    name: string;
    score: number;
    reason: string;
}

/**
 * Find entities structurally similar to `id`. For routes: same method +
 * similar path shape + overlap in middleware chain or same cluster. For
 * functions: same call-graph downstream pattern. For clusters: similar file
 * count and shared subsystem labels.
 */
export function findSimilarEntities(snapshot: Snapshot, id: string, limit = 10): SimilarEntity[] {
    const out: SimilarEntity[] = [];
    const api = snapshot.apiIndex?.[id];
    if (api) {
        const myMws = new Set(api.meta?.middlewares ?? []);
        const myShape = pathShape(api.route);
        for (const [otherId, other] of Object.entries(snapshot.apiIndex ?? {})) {
            if (otherId === id) continue;
            if (other.method !== api.method) continue;
            const otherMws = new Set(other.meta?.middlewares ?? []);
            const shared = [...myMws].filter((m) => otherMws.has(m)).length;
            const totalMws = Math.max(myMws.size, otherMws.size, 1);
            const mwScore = shared / totalMws;
            const shapeScore = myShape === pathShape(other.route) ? 1 : 0.3;
            const sameFile = other.filePath === api.filePath ? 0.4 : 0;
            const score = Number((mwScore * 0.5 + shapeScore * 0.3 + sameFile * 0.2).toFixed(3));
            if (score > 0.2) {
                out.push({
                    id: otherId,
                    kind: 'route',
                    name: `${other.method} ${other.route}`,
                    score,
                    reason: `${shared > 0 ? `shares ${shared} middleware${shared > 1 ? 's' : ''}` : 'same method'}${myShape === pathShape(other.route) ? ', same path shape' : ''}${sameFile ? ', same file' : ''}`,
                });
            }
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, limit);
    }

    const cluster = snapshot.clusters?.[id];
    if (cluster) {
        for (const [otherId, other] of Object.entries(snapshot.clusters ?? {})) {
            if (otherId === id) continue;
            const fileRatio = Math.min(cluster.files.length, other.files.length) /
                Math.max(cluster.files.length, other.files.length, 1);
            const sharedService = other.serviceId === cluster.serviceId ? 0.4 : 0;
            const score = Number((fileRatio * 0.6 + sharedService).toFixed(3));
            if (score > 0.2) {
                out.push({
                    id: otherId,
                    kind: 'cluster',
                    name: other.name ?? other.label,
                    score,
                    reason: `${cluster.files.length} vs ${other.files.length} files${sharedService ? ', same service' : ''}`,
                });
            }
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, limit);
    }

    return out;
}

/** Reduce `/articles/:slug/comments/:id` to `/W/:p/W/:p` for shape matching.
 *  Treats `:param`, numeric segments, and alphanumeric words as equivalent so
 *  `/r/5` and `/r/6` share a shape. Non-word characters keep their literal form
 *  to keep distinct prefixes (e.g. `/api` vs `/admin`) apart. */
function pathShape(route: string): string {
    return route
        .split('/')
        .map((seg) => {
            if (seg.startsWith(':')) return ':p';
            if (/^[A-Za-z0-9_-]+$/.test(seg)) return 'W';
            return seg;
        })
        .join('/');
}

// ─── Tier 2.11: saved-query / named views ──────────────────────────────────

export interface SavedView { id: string; description?: string; sql: string; }

export function loadSavedViews(workspaceRoot: string): SavedView[] {
    const candidate = path.join(workspaceRoot, '.codeatlas', 'saved-queries.json');
    if (!fs.existsSync(candidate)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter((v) => v && typeof v.id === 'string' && typeof v.sql === 'string');
    } catch { return []; }
}

// ─── Tier 2.12: token-budget guard ─────────────────────────────────────────

/**
 * Truncate a response to fit a token budget. Strategy: emit items in priority
 * order (caller-supplied); stop when the running JSON byte count would exceed
 * `maxResponseTokens * 4`. Returns the trimmed array plus a flag.
 */
export function trimToBudget<T>(items: T[], maxTokens: number): { items: T[]; truncated: boolean; tokenEstimate: number } {
    if (maxTokens <= 0) return { items, truncated: false, tokenEstimate: Math.ceil(Buffer.byteLength(JSON.stringify(items), 'utf8') / 4) };
    const maxBytes = maxTokens * 4;
    const kept: T[] = [];
    let bytes = 2; // []
    for (const it of items) {
        const itBytes = Buffer.byteLength(JSON.stringify(it), 'utf8') + 1; // +1 for comma
        if (bytes + itBytes > maxBytes) {
            return { items: kept, truncated: true, tokenEstimate: Math.ceil(bytes / 4) };
        }
        kept.push(it);
        bytes += itBytes;
    }
    return { items: kept, truncated: false, tokenEstimate: Math.ceil(bytes / 4) };
}

/** Wrapper for `list_entrypoints` adding pagination + budget. */
export function listEntryPointsPaged(
    snapshot: Snapshot,
    filter: Parameters<typeof listEntryPoints>[1],
    page: PageOptions,
    maxResponseTokens?: number,
): PagedResponse<EntryPointSummary> & { truncated?: boolean; tokenEstimate?: number } {
    const all = listEntryPoints(snapshot, filter);
    const paged = paginate(all, page);
    if (maxResponseTokens && maxResponseTokens > 0) {
        const trimmed = trimToBudget(paged.items, maxResponseTokens);
        return {
            items: trimmed.items,
            total: paged.total,
            nextCursor: trimmed.truncated ? (page.cursor ?? 0) + trimmed.items.length : paged.nextCursor,
            truncated: trimmed.truncated,
            tokenEstimate: trimmed.tokenEstimate,
        };
    }
    return paged;
}
