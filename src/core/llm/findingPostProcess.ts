/**
 * findingPostProcess.ts — deterministic checks that run AFTER the LLM emits
 * a finding but BEFORE we persist it.
 *
 * Two checks live here:
 *
 *   #514 — applicability gate. Catches cases like "auth required on writes"
 *          being flagged on a GET route, or "webhook signature" flagged on a
 *          non-webhook path. Rules are intentionally small and conservative;
 *          a finding the rules can't structurally verify is kept with
 *          `meta.unverified=true` so the UI can surface it in a separate bucket.
 *
 *   #516 — severity calibration. Bumps severity when the evidence quotes a
 *          known-bad pattern (hardcoded secret fallback, `eval`, plaintext
 *          password leak in URL, etc.) — the LLM defaults to `info` too often
 *          per #512's distribution analysis (31/39 info).
 *
 * Both functions are pure — easy to unit test, no LLM call, no I/O.
 */

import type {
    AiReviewSeverity, AiReviewCategory, AiReviewBinding,
} from '../graph/graphTypes';

export interface FindingShape {
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    bindings: AiReviewBinding[];
    /** Route the finding is attached to (e.g. "POST:/api/articles"). */
    entryPointId: string;
    /** Quoted evidence required by #513. */
    snippet?: string;
    /** Optional path/cluster signals from the api row. */
    method?: string;
    route?: string;
    clusterId?: string;
}

export interface PostProcessOutcome {
    keep: boolean;
    finding: FindingShape;
    /** Reason this was rejected — fed into the dropped-finding log. */
    droppedReason?: string;
    /** Mark when applicability could not be structurally verified. */
    unverified?: boolean;
}

/* ── #514 applicability rules ─────────────────────────────────────────── */

// Methods considered "writes" for auth-required guidelines.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Phrases that indicate a finding claims this is a write-route auth issue.
const AUTH_WRITE_PHRASES = [
    'auth on writes', 'authentication on writes', 'requires auth on writes',
    'auth required for write', 'missing auth on post', 'missing auth on put',
    'missing auth on patch', 'missing auth on delete', 'route requires auth',
    'enforce auth on writes',
];

// Phrases that indicate a webhook-signature claim.
const WEBHOOK_PHRASES = [
    'webhook signature', 'signature verification', 'verify signatures',
    'webhook routes', 'signed webhook',
];

const WEBHOOK_PATH_HINTS = /(^|\/)(webhook|webhooks|hooks|stripe|github|slack|twilio)(\/|$)/i;

function lower(s: string | undefined): string { return String(s ?? '').toLowerCase(); }

/**
 * #514 — gate guideline-category findings against simple structural rules.
 * Returns:
 *   keep=false when the finding's claim is structurally impossible (e.g.
 *     auth-on-writes flagged on a GET).
 *   unverified=true when applicability is opinion-only and we want the UI
 *     to surface it in a "needs review" bucket.
 *   otherwise the finding passes through.
 */
export function applyApplicabilityGate(input: FindingShape): PostProcessOutcome {
    if (input.category !== 'guideline') return { keep: true, finding: input };
    const titleBody = `${lower(input.title)} ${lower(input.body)}`;

    // Auth-on-writes guideline applied to non-write methods → drop.
    if (AUTH_WRITE_PHRASES.some((p) => titleBody.includes(p))) {
        const method = String(input.method ?? '').toUpperCase();
        if (method && !WRITE_METHODS.has(method)) {
            return {
                keep: false,
                finding: input,
                droppedReason: `auth-on-writes guideline does not apply to ${method} routes`,
            };
        }
    }

    // Webhook-signature guideline applied to a clearly non-webhook route → drop.
    if (WEBHOOK_PHRASES.some((p) => titleBody.includes(p))) {
        const route = lower(input.route);
        const cluster = lower(input.clusterId);
        const looksWebhook = WEBHOOK_PATH_HINTS.test(route) || cluster.includes('webhook');
        if (route && !looksWebhook) {
            return {
                keep: false,
                finding: input,
                droppedReason: 'webhook-signature guideline does not apply to non-webhook route',
            };
        }
    }

    // Falls into the "applicability is opinion" bucket — tag unverified but keep.
    return { keep: true, finding: input, unverified: true };
}

/* ── #516 severity calibration ────────────────────────────────────────── */

// Patterns whose presence in the evidence snippet justify bumping severity
// from info/warning to error. Pure pattern match — no LLM judgement.
const BUMP_TO_ERROR_PATTERNS: Array<{ re: RegExp; reason: string }> = [
    { re: /["'](?:super[\s_-]?secret|changeme|admin123|password)["']/i, reason: 'hardcoded credential string' },
    { re: /\b(?:JWT_SECRET|API_KEY|SECRET_KEY|PRIVATE_KEY)\s*\|\|\s*['"][^'"]+['"]/i, reason: 'env-var fallback to literal default for a secret' },
    { re: /\beval\s*\(/i, reason: 'use of eval()' },
    { re: /\bnew\s+Function\s*\(/i, reason: 'use of new Function()' },
    { re: /\bchild_process\s*\.\s*exec\s*\(\s*[^,]*\+/i, reason: 'shell injection — exec() with string concat' },
    { re: /\bdocument\.write\s*\(/i, reason: 'document.write — XSS surface' },
    { re: /innerHTML\s*=\s*[^=][^;]*\+/i, reason: 'innerHTML with concatenated user input — XSS' },
    { re: /\bdangerouslySetInnerHTML\b/, reason: 'dangerouslySetInnerHTML' },
    { re: /sql\s*[=:]\s*['"`][^'"`]*\$\{[^}]+\}/i, reason: 'template-string SQL with interpolation' },
];

// Patterns that justify bumping from info → warning. Looser than the error
// list; usually paired with a category match.
const BUMP_TO_WARNING_PATTERNS: Array<{ re: RegExp; categories?: AiReviewCategory[]; reason: string }> = [
    { re: /\bawait\s+prisma\.\w+\.\w+\([^)]*\)\s*;?(?:\s*\n[^}]*){0,3}\s*for\s*\(/, categories: ['performance', 'code-quality'], reason: 'await prisma call shortly followed by a loop — possible N+1' },
    { re: /for\s*\([^)]*\)\s*\{[^}]*await\s+prisma\./, categories: ['performance', 'code-quality'], reason: 'await prisma inside a for-loop — N+1' },
    { re: /\.map\s*\(\s*async/, categories: ['performance'], reason: 'async function inside .map() — likely sequential awaits' },
];

const RANK: Record<AiReviewSeverity, number> = { info: 0, warning: 1, error: 2 };

export interface CalibratedFinding {
    severity: AiReviewSeverity;
    calibrationReason?: string;
}

export function calibrateSeverity(input: { severity: AiReviewSeverity; category: AiReviewCategory; snippet?: string }): CalibratedFinding {
    const snippet = input.snippet ?? '';
    // Errors first — most consequential.
    for (const { re, reason } of BUMP_TO_ERROR_PATTERNS) {
        if (re.test(snippet) && RANK[input.severity] < RANK.error) {
            return { severity: 'error', calibrationReason: reason };
        }
    }
    if (RANK[input.severity] < RANK.warning) {
        for (const { re, categories, reason } of BUMP_TO_WARNING_PATTERNS) {
            if (categories && !categories.includes(input.category)) continue;
            if (re.test(snippet)) {
                return { severity: 'warning', calibrationReason: reason };
            }
        }
    }
    return { severity: input.severity };
}

/* ── Convenience: run both passes ──────────────────────────────────────── */

export function postProcessFinding(input: FindingShape): PostProcessOutcome {
    const calibrated = calibrateSeverity({
        severity: input.severity,
        category: input.category,
        snippet: input.snippet,
    });
    const withSeverity: FindingShape = { ...input, severity: calibrated.severity };
    const out = applyApplicabilityGate(withSeverity);
    if (calibrated.calibrationReason && out.keep) {
        out.finding.body = `${out.finding.body}\n\n[Severity calibrated to ${calibrated.severity}: ${calibrated.calibrationReason}]`;
    }
    return out;
}
