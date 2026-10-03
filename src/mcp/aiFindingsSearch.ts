/**
 * aiFindingsSearch.ts — natural-language search over AI-review findings (#510 — NL search over findings (intent-aware)).
 *
 * MVP: deterministic intent parser + keyword match. No LLM call.
 *   - Parses common phrases ("on the X flow", "in cluster X", "about auth",
 *     route patterns like "GET /api/articles") to infer scope.
 *   - Ranks findings by: scope match (entry-point / cluster / file) +
 *     keyword overlap in title/body, with a recency boost.
 *
 * Phase 2 (#510, follow-up): swap the parser for an LLM call that emits
 *   { scope, keywords } from the caller.
 *   Keeping the surface stable lets the upgrade be a drop-in.
 */

import type { AiReviewFinding } from '../core/graph/graphTypes';
import type { SnapshotStore } from '../core/storage/snapshotStore';

const METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i;
const ROUTE_RE = /(\/(?:[a-z0-9_:.-]+|\{[^}]+\}|:[a-z0-9_]+)+)/i;
const CLUSTER_HINTS = ['cluster', 'feature', 'module', 'area'];
const FLOW_HINTS = ['flow', 'handler', 'endpoint', 'route'];
const FILE_HINTS = ['file', 'in ', 'inside '];

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'has', 'have',
    'in', 'into', 'is', 'it', 'me', 'of', 'on', 'or', 'show', 'that', 'the', 'this',
    'to', 'was', 'what', 'when', 'where', 'which', 'why', 'with', 'about', 'find',
    'findings', 'finding', 'review', 'ai',
]);

export interface ParsedIntent {
    scope: {
        entryPointId?: string;
        clusterId?: string;
        filePath?: string;
    };
    keywords: string[];
    severity?: 'info' | 'warning' | 'error';
    raw: string;
}

export function parseIntent(query: string, store: SnapshotStore): ParsedIntent {
    const out: ParsedIntent = { scope: {}, keywords: [], raw: query };
    if (!query || typeof query !== 'string') return out;

    const q = query.trim();

    // Severity
    if (/\b(error|errors|critical)\b/i.test(q)) out.severity = 'error';
    else if (/\b(warning|warnings|warn)\b/i.test(q)) out.severity = 'warning';
    else if (/\b(info|informational)\b/i.test(q)) out.severity = 'info';

    // Route + method → entry-point scope
    const methodMatch = q.match(METHOD_RE);
    const routeMatch = q.match(ROUTE_RE);
    if (routeMatch) {
        const method = (methodMatch?.[1] ?? '').toUpperCase();
        const route = routeMatch[1];
        // Try to match an actual entry point. If method known, scope to method:route.
        const snapshot = store.getWorking();
        const apis = snapshot?.apiIndex ?? {};
        const candidates = Object.values(apis).filter((a: any) => {
            if (!a) return false;
            if (method && String(a.method ?? '').toUpperCase() !== method) return false;
            return String(a.route ?? '').toLowerCase() === route.toLowerCase();
        });
        if (candidates.length === 1) {
            const c: any = candidates[0];
            out.scope.entryPointId = `${String(c.method).toUpperCase()}:${c.route}`;
        }
    }

    // Cluster hints — "auth cluster" or "cluster auth" or "the article module"
    const lower = q.toLowerCase();
    for (const hint of CLUSTER_HINTS) {
        const idx = lower.indexOf(hint);
        if (idx === -1) continue;
        const around = lower.slice(Math.max(0, idx - 32), idx + hint.length + 32);
        const m = around.match(/[a-z0-9_-]+\s+(?:cluster|feature|module|area)|(?:cluster|feature|module|area)[:\s]+([a-z0-9_-]+)/i);
        if (m) {
            const word = (m[1] ?? m[0].split(/\s+/)[0]).replace(/^(cluster|feature|module|area)$/i, '');
            const clean = word.replace(/[:.]+$/, '').trim();
            if (clean) out.scope.clusterId = `cluster:${clean}`;
            break;
        }
    }

    // File hint — exact substring against known file paths
    if (FILE_HINTS.some((h) => lower.includes(h))) {
        const snapshot = store.getWorking();
        const files = Object.keys(snapshot?.files ?? {});
        // Pick the file whose basename appears as a whole word in the query.
        for (const fp of files) {
            const base = fp.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
            if (base.length < 4) continue;
            const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (re.test(q)) { out.scope.filePath = fp; break; }
        }
    }

    // Keywords — words minus stopwords, scope tokens, severities.
    const tokens = q
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((t) => t && t.length > 2 && !STOPWORDS.has(t));
    out.keywords = Array.from(new Set(tokens));

    return out;
}

function scoreFinding(f: AiReviewFinding, intent: ParsedIntent): number {
    let s = 0;
    // Scope matches dominate.
    if (intent.scope.entryPointId && f.entryPointId === intent.scope.entryPointId) s += 50;
    if (intent.scope.clusterId && f.bindings.some((b) => b.graphId.endsWith(intent.scope.clusterId!) || b.graphId.includes(intent.scope.clusterId!))) s += 35;
    if (intent.scope.filePath && f.anchor?.filePath === intent.scope.filePath) s += 30;
    if (intent.scope.filePath && f.bindings.some((b) => b.graphId.includes(intent.scope.filePath!))) s += 20;

    // Severity preference.
    if (intent.severity && f.severity === intent.severity) s += 8;

    // Keyword overlap in title (×3) and body (×1).
    const hay = `${f.title} ${f.body} ${f.category} ${f.entryPointId}`.toLowerCase();
    for (const k of intent.keywords) {
        if (f.title.toLowerCase().includes(k)) s += 6;
        else if (hay.includes(k)) s += 2;
    }

    // Recency: newer findings rank higher.
    const ageMs = Date.now() - Date.parse(f.updatedAt || f.createdAt || new Date().toISOString());
    if (Number.isFinite(ageMs) && ageMs >= 0) {
        const days = ageMs / (24 * 3600 * 1000);
        s += Math.max(0, 5 - days);
    }
    return s;
}

export interface FindingSearchResult {
    intent: ParsedIntent;
    matches: Array<{ finding: AiReviewFinding; score: number; reason: string }>;
    totalScanned: number;
}

export function searchFindings(store: SnapshotStore, query: string, limit = 20): FindingSearchResult {
    const intent = parseIntent(query, store);
    const all = store.listAiReviewFindings({ status: 'open' });
    const scored: Array<{ finding: AiReviewFinding; score: number; reason: string }> = [];
    for (const f of all) {
        const score = scoreFinding(f, intent);
        if (score <= 0) continue;
        const reasons: string[] = [];
        if (intent.scope.entryPointId && f.entryPointId === intent.scope.entryPointId) reasons.push('entry-point match');
        if (intent.scope.clusterId && f.bindings.some((b) => b.graphId.includes(intent.scope.clusterId!))) reasons.push('cluster match');
        if (intent.scope.filePath && (f.anchor?.filePath === intent.scope.filePath)) reasons.push('file match');
        const titleHit = intent.keywords.some((k) => f.title.toLowerCase().includes(k));
        if (titleHit) reasons.push('keyword in title');
        scored.push({ finding: f, score, reason: reasons.join(' + ') || 'keyword' });
    }
    scored.sort((a, b) => b.score - a.score);
    return { intent, matches: scored.slice(0, limit), totalScanned: all.length };
}
