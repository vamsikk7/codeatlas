/**
 * llmNamingService.ts
 *
 * Background enrichment of cluster names and service descriptions using LLM.
 * - Calls OpenRouter with a free model (default: mistral-7b-instruct)
 * - Caches results in `.codeatlas/llm-names.json` keyed by membership hash
 * - Falls back gracefully when API key is missing or request fails
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sendOpenRouterRequest, DEFAULT_OPENROUTER_CONFIG } from './openRouterClient';
import type { OpenRouterConfig } from './openRouterClient';
import { parseLlmJson } from './safeJson';
import type { FeatureCluster, ServiceRecord, ApiRecord } from '../graph/graphTypes';
import type { SqliteStore } from '../storage/sqliteStore';

interface LlmNameCache {
    /** cluster membership hash → LLM-generated name */
    clusters: Record<string, string>;
    /** service ID → LLM-generated description */
    services: Record<string, string>;
    /** API ID → LLM-generated annotation */
    apis: Record<string, string>;
}

const LEGACY_CACHE_FILE = 'llm-names.json';

export class LlmNamingService {
    private workspaceRoot: string;
    private sqlite: SqliteStore;
    private config: OpenRouterConfig | null = null;
    private cache: LlmNameCache = { clusters: {}, services: {}, apis: {} };
    private cacheLoaded: boolean = false;
    private log: (msg: string) => void = () => { /* noop */ };

    constructor(workspaceRoot: string, sqlite: SqliteStore) {
        this.workspaceRoot = workspaceRoot;
        this.sqlite = sqlite;
        // Cache hydration is lazy: SqliteStore.init() must run before the
        // first cache read, but extension.ts constructs services *before*
        // awaiting that init. ensureLoaded() handles the deferred hydrate.
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /**
     * Configure the OpenRouter client. Called when API key becomes available.
     */
    configure(apiKey: string, model?: string, provider?: string): void {
        // UX-49 (2026-06-04): per-provider timeout. Local providers
        // (Ollama, custom self-hosted) run inference on the user's
        // machine — a single cluster-name pass with a 7B model on
        // an M-series Mac is typically 8-30s, with 70B / first-load
        // models taking 60s+. The previous fixed 10s default aborted
        // every nameCluster call on Ollama, producing the persistent
        // `nameCluster failed: ollama request failed: This operation
        // was aborted` errors users reported. Matches the same
        // local-vs-hosted split aiReviewHandlers
        // already use (`isLocal ? 120_000 : 30_000`).
        const p = (provider ?? '').toLowerCase();
        const isLocal = p === 'ollama' || p === 'custom';
        this.config = {
            apiKey,
            model: model ?? DEFAULT_OPENROUTER_CONFIG.model,
            timeoutMs: isLocal ? 120_000 : 30_000,
            provider: provider ?? DEFAULT_OPENROUTER_CONFIG.provider,
        };
    }

    get isConfigured(): boolean {
        if (!this.config) return false;
        const provider = this.config.provider?.toLowerCase();
        if (provider === 'ollama' || provider === 'custom') return true;
        return this.config.apiKey.length > 0;
    }

    // ─── Cluster naming ────────────────────────────────────────────────

    /**
     * Generate a semantic name for a cluster.
     * Returns the LLM name or the structural label as fallback.
     */
    async nameCluster(
        cluster: FeatureCluster,
        fileContents: Record<string, string>,
    ): Promise<string> {
        if (!this.config) return cluster.label;

        this.ensureLoaded();
        const hash = this.clusterMembershipHash(cluster);
        if (this.cache.clusters[hash]) return this.cache.clusters[hash];

        const fileSummaries = cluster.files.slice(0, 8).map((f) => {
            const content = fileContents[f] ?? '';
            const snippet = redactSecrets(content.slice(0, 200).replace(/\n/g, ' '));
            return `- ${f}: ${snippet}`;
        }).join('\n');

        // Issue #768: the previous prompt ("Give a 1-3 word domain name
        // for this module") led code-completion models to echo phrasings
        // like "The domain name of this module is …" — which the
        // sanitizer then truncated to a meaningless "The domain name of
        // this" cluster label. Recast as a direct-answer prompt so the
        // model emits ONLY the name with no scaffolding.
        const prompt = `Files in this module:\n${fileSummaries}\n\nReply with a short title (2-3 words, Title Case) that names what this module does. No prefix, no quotes, no explanation. Examples: "User Authentication", "Payment Processing", "Todo Management".`;

        try {
            // Issue #429 — force temperature=0 for deterministic naming so the
            // same prompt always returns the same name across cascade rebuilds.
            // Non-deterministic names propagate as `modified` annotations at
            // L2a → L1 and cause the post-revert pollution documented in #433
            // and #435.
            const resp = await sendOpenRouterRequest(
                { ...this.config, temperature: 0 },
                [{ role: 'user', content: prompt }],
            );
            const name = sanitizeName(resp.text);
            if (!name) return cluster.label; // Issue 144: invalid LLM output → use algorithmic name
            this.cache.clusters[hash] = name;
            this.saveCache();
            return name;
        } catch (err: any) {
            this.log(`[LLM] nameCluster failed: ${err?.message ?? err}`);
            return cluster.label;
        }
    }

    /**
     * Name all clusters in a batch (non-blocking).
     * Returns updated cluster record with enriched names.
     */
    async nameClusters(
        clusters: Record<string, FeatureCluster>,
        fileContents: Record<string, string>,
    ): Promise<Record<string, FeatureCluster>> {
        const result = { ...clusters };
        for (const [id, cluster] of Object.entries(result)) {
            const name = await this.nameCluster(cluster, fileContents);
            result[id] = { ...cluster, name };
        }
        return result;
    }

    // ─── Service description ───────────────────────────────────────────

    async summarizeService(
        service: ServiceRecord,
        apis: ApiRecord[],
    ): Promise<string> {
        if (!this.config) return '';
        this.ensureLoaded();
        if (this.cache.services[service.id]) return this.cache.services[service.id];

        const apiList = apis.slice(0, 10).map((a) => `${a.method} ${a.route}`).join(', ');
        const prompt = `This service (${service.id}) exposes these APIs: ${apiList}. Give a 1-sentence description of what it does. Reply with ONLY the description.`;

        try {
            // #429 — temperature=0 so service descriptions stay stable across
            // rebuilds; same input must produce same description or the diff
            // system flags every service on every cascade.
            const resp = await sendOpenRouterRequest(
                { ...this.config, temperature: 0 },
                [{ role: 'user', content: prompt }],
            );
            const desc = resp.text.slice(0, 200);
            this.cache.services[service.id] = desc;
            this.saveCache();
            return desc;
        } catch (err: any) {
            this.log(`[LLM] summarizeService failed: ${err?.message ?? err}`);
            return '';
        }
    }

    // ─── Sequence flow annotation ──────────────────────────────────────

    async annotateSequenceFlow(api: ApiRecord): Promise<string> {
        if (!this.config) return '';
        this.ensureLoaded();
        if (this.cache.apis[api.apiId]) return this.cache.apis[api.apiId];

        const prompt = `What does "${api.method} ${api.route}" do? Reply in 3-5 words as a verb phrase (e.g. "Create a new todo item"). Reply with ONLY the phrase.`;

        try {
            // #429 — temperature=0 for stable per-API annotations.
            const resp = await sendOpenRouterRequest(
                { ...this.config, temperature: 0 },
                [{ role: 'user', content: prompt }],
            );
            const annotation = sanitizeName(resp.text);
            this.cache.apis[api.apiId] = annotation;
            this.saveCache();
            return annotation;
        } catch (err: any) {
            this.log(`[LLM] annotateSequenceFlow failed: ${err?.message ?? err}`);
            return '';
        }
    }

    // ─── Cache management ──────────────────────────────────────────────

    /** Compute a hash of the cluster's file membership for cache invalidation. */
    clusterMembershipHash(cluster: FeatureCluster): string {
        const sorted = [...cluster.files].sort().join('\n');
        return crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
    }

    isCached(cluster: FeatureCluster): boolean {
        this.ensureLoaded();
        const hash = this.clusterMembershipHash(cluster);
        return hash in this.cache.clusters;
    }

    getCachedName(cluster: FeatureCluster): string | undefined {
        this.ensureLoaded();
        return this.cache.clusters[this.clusterMembershipHash(cluster)];
    }

    clearCache(): void {
        this.cache = { clusters: {}, services: {}, apis: {} };
        try {
            this.sqlite.run(`DELETE FROM llm_cluster_names`, []);
            this.sqlite.run(`DELETE FROM llm_service_descriptions`, []);
            this.sqlite.run(`DELETE FROM llm_api_annotations`, []);
            this.sqlite.flush();
        } catch (err: any) {
            this.log(`[LLM] clearCache failed: ${err?.message ?? err}`);
        }
        // Best-effort delete of the legacy file too.
        try {
            const legacy = path.join(this.workspaceRoot, '.codeatlas', LEGACY_CACHE_FILE);
            if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
        } catch { /* best-effort */ }
    }

    /** Hydrate cache from SQLite (and import legacy JSON on first call). */
    private ensureLoaded(): void {
        if (this.cacheLoaded) return;
        try {
            for (const row of this.sqlite.all(`SELECT membership_hash, name FROM llm_cluster_names`)) {
                this.cache.clusters[String(row.membership_hash)] = String(row.name);
            }
            for (const row of this.sqlite.all(`SELECT service_id, description FROM llm_service_descriptions`)) {
                this.cache.services[String(row.service_id)] = String(row.description);
            }
            for (const row of this.sqlite.all(`SELECT api_id, annotation FROM llm_api_annotations`)) {
                this.cache.apis[String(row.api_id)] = String(row.annotation);
            }
            // Legacy JSON one-shot import: only if every table was empty.
            const empty = Object.keys(this.cache.clusters).length === 0
                && Object.keys(this.cache.services).length === 0
                && Object.keys(this.cache.apis).length === 0;
            if (empty) this.importLegacyJson();
            this.cacheLoaded = true;
        } catch (err: any) {
            this.log(`[LLM] ensureLoaded failed: ${err?.message ?? err}`);
            this.cacheLoaded = true; // give up; degrade gracefully
        }
    }

    private importLegacyJson(): void {
        const legacy = path.join(this.workspaceRoot, '.codeatlas', LEGACY_CACHE_FILE);
        if (!fs.existsSync(legacy)) return;
        try {
            const raw = fs.readFileSync(legacy, 'utf-8');
            const parsed = parseLlmJson<any>(raw); // #891 — proto-safe (spread into cache records below)
            if (parsed && typeof parsed === 'object') {
                if (parsed.clusters) Object.assign(this.cache.clusters, parsed.clusters);
                if (parsed.services) Object.assign(this.cache.services, parsed.services);
                if (parsed.apis) Object.assign(this.cache.apis, parsed.apis);
                // Persist into SQL so next load is fast.
                const refId = this.sqlite.currentGitRefId();
                this.sqlite.transaction(() => {
                    for (const [hash, name] of Object.entries(this.cache.clusters)) {
                        this.sqlite.run(
                            `INSERT INTO llm_cluster_names (membership_hash, git_ref_id, name) VALUES (?, ?, ?)
                             ON CONFLICT(membership_hash) DO UPDATE SET git_ref_id = excluded.git_ref_id, name = excluded.name`,
                            [hash, refId, String(name)],
                        );
                    }
                    for (const [id, desc] of Object.entries(this.cache.services)) {
                        this.sqlite.run(
                            `INSERT INTO llm_service_descriptions (service_id, git_ref_id, description) VALUES (?, ?, ?)
                             ON CONFLICT(service_id) DO UPDATE SET git_ref_id = excluded.git_ref_id, description = excluded.description`,
                            [id, refId, String(desc)],
                        );
                    }
                    for (const [id, ann] of Object.entries(this.cache.apis)) {
                        this.sqlite.run(
                            `INSERT INTO llm_api_annotations (api_id, git_ref_id, annotation) VALUES (?, ?, ?)
                             ON CONFLICT(api_id) DO UPDATE SET git_ref_id = excluded.git_ref_id, annotation = excluded.annotation`,
                            [id, refId, String(ann)],
                        );
                    }
                });
                this.sqlite.flush();
                this.log(`[LLM] Imported legacy llm-names.json (${Object.keys(this.cache.clusters).length}c/${Object.keys(this.cache.services).length}s/${Object.keys(this.cache.apis).length}a)`);
            }
        } catch (err: any) {
            this.log(`[LLM] Legacy llm-names.json import failed: ${err?.message ?? err}`);
        }
    }

    private saveCache(): void {
        // Re-write all three tables. Inputs are small (cache hashes / service IDs / api IDs)
        // so per-key UPSERT cost is negligible; keeps `cache` <-> SQL in sync.
        try {
            this.ensureLoaded();
            const refId = this.sqlite.currentGitRefId();
            this.sqlite.transaction(() => {
                for (const [hash, name] of Object.entries(this.cache.clusters)) {
                    this.sqlite.run(
                        `INSERT INTO llm_cluster_names (membership_hash, git_ref_id, name) VALUES (?, ?, ?)
                         ON CONFLICT(membership_hash) DO UPDATE SET git_ref_id = excluded.git_ref_id, name = excluded.name`,
                        [hash, refId, String(name)],
                    );
                }
                for (const [id, desc] of Object.entries(this.cache.services)) {
                    this.sqlite.run(
                        `INSERT INTO llm_service_descriptions (service_id, git_ref_id, description) VALUES (?, ?, ?)
                         ON CONFLICT(service_id) DO UPDATE SET git_ref_id = excluded.git_ref_id, description = excluded.description`,
                        [id, refId, String(desc)],
                    );
                }
                for (const [id, ann] of Object.entries(this.cache.apis)) {
                    this.sqlite.run(
                        `INSERT INTO llm_api_annotations (api_id, git_ref_id, annotation) VALUES (?, ?, ?)
                         ON CONFLICT(api_id) DO UPDATE SET git_ref_id = excluded.git_ref_id, annotation = excluded.annotation`,
                        [id, refId, String(ann)],
                    );
                }
            });
            this.sqlite.flush();
        } catch (err: any) {
            this.log(`[LLM] saveCache failed: ${err?.message ?? err}`);
        }
    }
}

/**
 * Issue #429: Refusal-phrase / hallucination patterns that LLMs (especially
 * smaller local models like deepseek-coder 6.7B and quantized mistral) emit
 * when they can't classify the cluster. Returning these verbatim as the
 * cluster name pollutes the L2a feature graph with garbage on every cascade.
 *
 * Match against the RAW response (before any cleanup) — these phrases are
 * the model's own opening tokens, never a legitimate domain name.
 */
const REFUSAL_PHRASE_PREFIXES = [
    /^as an\b/i,                  // "As an AI model developed by..."
    /^i am\b/i, /^i'm\b/i,        // "I am sorry...", "I'm not sure..."
    /^i'?d\b/i,                   // "I'd say...", "I'd guess..."
    /^i don'?t\b/i,               // "I don't have enough..."
    /^i cannot\b/i, /^i can'?t\b/i,
    /^i think\b/i, /^i believe\b/i, /^i would\b/i,
    /^sorry[,\s]/i, /^my apologies\b/i,
    /^this appears\b/i, /^this seems\b/i, /^this looks\b/i,
    /^it appears\b/i, /^it seems\b/i, /^it looks\b/i,
    /^the (?:module|cluster|folder|system|code|function|files?) (?:seems|appears|looks|is|are)\b/i,
    /^based on\b/i, /^given\b/i, /^looking at\b/i,
    /^let me\b/i, /^well[,\s]/i, /^hmm\b/i,
    /^possibly\b/i, /^perhaps\b/i, /^maybe\b/i,
    /^there (?:is|are|seems)\b/i,
    /^without more (?:context|information)\b/i,
];

function isRefusalOrHallucination(raw: string): boolean {
    const trimmed = raw.replace(/^["'\s]+/, '').trim();
    if (!trimmed) return false;
    return REFUSAL_PHRASE_PREFIXES.some((re) => re.test(trimmed));
}

/**
 * Sanitize LLM output: strip quotes, limit to 5 words, remove trailing punctuation.
 * Issue #429: reject refusal-phrase preambles and vague-observation patterns
 * BEFORE any cleanup so they can't be cached as the cluster's name.
 */
function sanitizeName(raw: string): string {
    // Issue #429 — refusal-phrase / hallucination guard. Reject the WHOLE
    // response if it starts with a known model-confusion preamble; caller
    // falls back to the structural label and does NOT cache the rejected
    // value, so a future rebuild gets another chance at a real name.
    if (isRefusalOrHallucination(raw)) {
        return '';
    }

    let name = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/[.!?]+$/, '');
    // Issue 144 / #768: Strip common LLM preamble patterns. Code-completion
    // models sometimes echo the prompt's phrasing instead of just emitting
    // the name. The csharp-aspnet repo's L2a showed 4 clusters labelled
    // "The domain name of this" because the model returned "The domain name
    // of this module is …" and the prior regex only stripped the "for"
    // variant. Now handle "of"/"for"/"in"/"to" + truncation at "is/be/would".
    // Issue #768: strip prompt-echo preamble patterns. Several smaller
    // models (especially code-completion variants) re-emit the prompt
    // phrasing before delivering the answer. Apply each pattern as a
    // separate replace to keep the regexes simple + rollup-parseable.
    const STRIP_PATTERNS: RegExp[] = [
        /^The (?:domain )?name for this (?:module|cluster|feature|component|service|package)(?: (?:would|could|might) be| is)?\s*[:\-—]?\s*/i,
        /^The (?:domain )?name of this (?:module|cluster|feature|component|service|package)?(?: (?:would|could|might) be| is)?\s*[:\-—]?\s*/i,
        /^This (?:module|cluster|feature|component|service|package)\s+(?:is|handles|manages|provides|covers)\s*/i,
        /^(?:Module|Cluster|Feature|Component|Service|Package)\s*[:\-—]\s*/i,
        /^(?:Name|Label|Domain)\s*[:\-—]\s*/i,
    ];
    for (const re of STRIP_PATTERNS) name = name.replace(re, '');
    name = name.replace(/^["'\s]+|["'\s]+$/g, '');
    const words = name.split(/\s+/);
    if (words.length > 5) name = words.slice(0, 5).join(' ');
    // Reject if still looks like a sentence (>30 chars or contains code patterns)
    if (name.length > 40 || /[{}();=<>]/.test(name) || /\bfunction\b|\bconst\b|\bimport\b/.test(name)) {
        return ''; // Caller falls back to algorithmic label
    }
    // Issue #768: reject prompt-echo residues — phrases that survived the
    // preamble strip but are clearly the model regurgitating the prompt.
    // These show up as "The domain name of this", "the name for this module",
    // etc. — never an actual cluster name.
    if (/^the (?:domain )?name\b/i.test(name)) return '';
    if (/^this (?:module|cluster|feature|component|service|package)\b/i.test(name)) return '';
    if (/^(?:module|cluster|feature|component|service|package)$/i.test(name.trim())) return '';
    return name || '';
}

/**
 * Redact potential secrets from code snippets before sending to external API.
 * Replaces lines containing common secret patterns with [REDACTED].
 */
export function redactSecrets(text: string): string {
    // #932 — VALUE-ONLY redaction. The previous form `(KEYWORD)\s*[=:]\s*\S+`
    // matched the keyword as a SUBSTRING (`Token` inside `appAccessToken`,
    // `ZohoToken`, `refreshAccessToken`) and then swallowed the ENTIRE RHS —
    // including function calls and expressions — so it shredded ordinary code the
    // reviewer needs to see: `const accessToken = getToken()` → `const access[REDACTED]`,
    // `const token = res?.data` → `const [REDACTED]`, `type FooToken = {…}` → `type Foo[REDACTED]`.
    // That blinded the AI reviewer to the surrounding logic (cal.com #11059 G5).
    // Mirror snapshotStore.redactLine: mask only a literal secret VALUE (a quoted
    // string, or a long bare credential token that does NOT start an expression/call
    // and isn't a property access), and KEEP the key + code-shaped RHS intact.
    const KEYS = '(?:PASSWORD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|ENCRYPTION_KEY)';
    const credentialValuePattern = /[A-Za-z0-9_\-./=+]{8,}/;
    return text
        // KEY = "literal" / KEY: "literal"  → mask just the quoted value, keep the key.
        .replace(new RegExp(`${KEYS}\\s*[=:]\\s*['"][^'"]{4,}['"]`, 'gi'),
            (m) => m.replace(/['"][^'"]{4,}['"]/, '"[REDACTED]"'))
        // KEY = bareToken (env-style)  → mask only when it looks like a raw credential:
        // not the start of a string/array/object/call/negation, value-terminated, ≥8
        // chars, not a reserved word, and NOT a `foo.bar` property access (real code).
        .replace(new RegExp(`${KEYS}\\s*[=:]\\s*(?!['"\\[\\{(!])([A-Za-z0-9_\\-./=+]{8,})(?=\\s|;|,|$)`, 'gi'),
            (m: string, val: string) => {
                if (!credentialValuePattern.test(val)) return m;
                if (/[A-Za-z]\.[A-Za-z]/.test(val)) return m; // `obj.prop` — a property access, not a token
                if (/\b(?:import|require|process|env|input|req|res|this|new|typeof|instanceof|null|undefined|true|false|await|return|function|async)\b/.test(val)) return m;
                return m.replace(/([=:])\s*[A-Za-z0-9_\-./=+]{8,}/, '$1 "[REDACTED]"');
            })
        .replace(/Bearer\s+[A-Za-z0-9_\-.]{10,}/gi, 'Bearer [REDACTED]')
        .replace(/https?:\/\/[^:\s]+:[^@\s]+@/gi, 'http://[REDACTED]@')
        .replace(/(?:mongodb|postgres|mysql|redis|amqp|amqps):\/\/[^\s'")\]}{,]+/gi, '[REDACTED_URI]');
}
