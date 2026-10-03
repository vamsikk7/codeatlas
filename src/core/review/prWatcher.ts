/**
 * prWatcher.ts — #851 (2026-06-12).
 *
 * Local PR watcher: polls GitHub for open pull requests on the current repo
 * and runs the #850 review flow (ADR-044) once per PR head sha, posting the
 * review back to GitHub. No CI required — this is the "CodeRabbit without
 * the webhook" mode, toggled from the browser UI card.
 *
 * Everything external is injected (fetch-based PR listing, the review
 * runner, the reviewed-sha ledger, timers, clock) so the scheduling and
 * dedupe logic is fully unit-testable. The default review runner lives in
 * `prCloneRunner.ts` — it NEVER touches the user's live working tree.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PrSummary {
    number: number;
    title: string;
    headSha: string;
    baseSha: string;
    baseRef: string;
}

export interface PrWatcherStatus {
    enabled: boolean;
    repoSlug: string | null;
    tokenPresent: boolean;
    llmKeyPresent: boolean;
    intervalMs: number;
    lastPollAt: number | null;
    /** Human-readable one-liner for the UI card ("2 open PRs · reviewed #12"). */
    lastResult: string | null;
    lastError: string | null;
    reviewedCount: number;
    /** True while a tick is actively polling/reviewing. */
    polling: boolean;
}

/** Reviewed-sha ledger — `prNumber → last reviewed head sha`. A PR is
 *  re-reviewed only when its head moves (new push). */
export interface PrReviewLedger {
    get(prNumber: number): string | undefined;
    set(prNumber: number, headSha: string): void;
    size(): number;
}

export interface PrWatcherDeps {
    /** Resolved lazily every tick so a remote added mid-session is picked up. */
    repoSlug: () => string | null;
    getToken: () => Promise<string | undefined>;
    hasLlmKey: () => Promise<boolean>;
    listOpenPrs: (slug: string, token: string) => Promise<PrSummary[]>;
    reviewPr: (pr: PrSummary, ctx: { slug: string; token: string }) => Promise<{ ok: boolean; error?: string }>;
    ledger: PrReviewLedger;
    log: (msg: string) => void;
    /** Default 5 minutes. Clamped to ≥ 60s so a bad setting can't hammer the API. */
    intervalMs?: number;
    /** Called after every status change (start/stop/tick) — broadcast hook. */
    onStatus?: (s: PrWatcherStatus) => void;
    now?: () => number;
    timer?: {
        set(fn: () => void, ms: number): unknown;
        clear(handle: unknown): void;
    };
}

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export class PrWatcher {
    private deps: PrWatcherDeps;
    private enabled = false;
    private handle: unknown = null;
    private ticking = false;
    private cancelTick = false;
    private lastPollAt: number | null = null;
    private lastResult: string | null = null;
    private lastError: string | null = null;
    private tokenPresent = false;
    private llmKeyPresent = false;

    constructor(deps: PrWatcherDeps) {
        this.deps = deps;
    }

    private get intervalMs(): number {
        return Math.max(MIN_INTERVAL_MS, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    }

    getStatus(): PrWatcherStatus {
        return {
            enabled: this.enabled,
            repoSlug: this.deps.repoSlug(),
            tokenPresent: this.tokenPresent,
            llmKeyPresent: this.llmKeyPresent,
            intervalMs: this.intervalMs,
            lastPollAt: this.lastPollAt,
            lastResult: this.lastResult,
            lastError: this.lastError,
            reviewedCount: this.deps.ledger.size(),
            polling: this.ticking,
        };
    }

    /** Refresh token/key presence without polling — used by getStatus
     *  handlers so the card shows accurate prerequisites even when OFF. */
    async refreshPrereqs(): Promise<PrWatcherStatus> {
        this.tokenPresent = Boolean(await this.deps.getToken());
        this.llmKeyPresent = await this.deps.hasLlmKey();
        return this.getStatus();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Idempotent. Ticks immediately, then on the interval. */
    start(): void {
        if (this.enabled) return;
        this.enabled = true;
        this.lastError = null;
        this.deps.log(`[pr-watcher] started (interval ${Math.round(this.intervalMs / 1000)}s)`);
        this.emit();
        void this.tick();
        this.schedule();
    }

    stop(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.cancelTick = true; // a tick mid-review bails before the next PR
        if (this.handle != null) {
            (this.deps.timer ?? defaultTimer).clear(this.handle);
            this.handle = null;
        }
        this.deps.log('[pr-watcher] stopped');
        this.emit();
    }

    private schedule(): void {
        if (!this.enabled) return;
        this.handle = (this.deps.timer ?? defaultTimer).set(() => {
            void this.tick();
            this.schedule();
        }, this.intervalMs);
    }

    private emit(): void {
        this.deps.onStatus?.(this.getStatus());
    }

    /** One poll cycle. Never throws; failures land in `lastError`.
     *  Re-entrancy guard: a slow review run can outlive the interval. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        this.cancelTick = false;
        this.emit();
        try {
            this.lastPollAt = (this.deps.now ?? Date.now)();
            const slug = this.deps.repoSlug();
            if (!slug) {
                this.lastResult = null;
                this.lastError = 'no GitHub remote detected on this repo';
                return;
            }
            const token = await this.deps.getToken();
            this.tokenPresent = Boolean(token);
            if (!token) {
                this.lastResult = null;
                this.lastError = 'no GitHub token (set GITHUB_TOKEN or sign in)';
                return;
            }
            this.llmKeyPresent = await this.deps.hasLlmKey();
            if (!this.llmKeyPresent) {
                this.lastResult = null;
                this.lastError = 'no LLM API key configured';
                return;
            }
            const prs = await this.deps.listOpenPrs(slug, token);
            const pending = prs.filter((pr) => this.deps.ledger.get(pr.number) !== pr.headSha);
            const reviewed: number[] = [];
            const failed: number[] = [];
            for (const pr of pending) {
                if (this.cancelTick) break; // stop() arrived mid-tick — bail out
                this.deps.log(`[pr-watcher] reviewing PR #${pr.number} @ ${pr.headSha.slice(0, 7)}`);
                const out = await this.deps.reviewPr(pr, { slug, token });
                if (out.ok) {
                    this.deps.ledger.set(pr.number, pr.headSha);
                    reviewed.push(pr.number);
                } else {
                    failed.push(pr.number);
                    this.deps.log(`[pr-watcher] PR #${pr.number} review failed: ${out.error}`);
                }
            }
            const parts = [`${prs.length} open PR${prs.length === 1 ? '' : 's'}`];
            if (reviewed.length) parts.push(`reviewed ${reviewed.map((n) => `#${n}`).join(', ')}`);
            if (failed.length) parts.push(`failed ${failed.map((n) => `#${n}`).join(', ')}`);
            if (!reviewed.length && !failed.length) parts.push('nothing new');
            this.lastResult = parts.join(' · ');
            this.lastError = failed.length ? `review failed for ${failed.map((n) => `#${n}`).join(', ')}` : null;
        } catch (err: any) {
            this.lastError = (err?.message ?? String(err)).slice(0, 200);
            this.deps.log(`[pr-watcher] poll failed: ${this.lastError}`);
        } finally {
            this.ticking = false;
            this.emit();
        }
    }
}

const defaultTimer = {
    set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clear: (h: unknown): void => clearTimeout(h as NodeJS.Timeout),
};

/** Default open-PR lister — GitHub REST, injectable fetch for tests. */
export async function listOpenPrsGithub(
    slug: string,
    token: string,
    fetchImpl: (url: string, init?: any) => Promise<any> = fetch as any,
): Promise<PrSummary[]> {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}/pulls?state=open&per_page=50`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'codeatlas-pr-watcher',
        },
    });
    if (!res.ok) throw new Error(`GitHub PR list failed (${res.status})`);
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
        number: r.number,
        title: String(r.title ?? ''),
        headSha: String(r.head?.sha ?? ''),
        baseSha: String(r.base?.sha ?? ''),
        baseRef: String(r.base?.ref ?? ''),
    })).filter((p: PrSummary) => p.number > 0 && p.headSha);
}

/** File-backed ledger at `<storageDir>/pr-watcher.json` — survives restarts
 *  so an unchanged PR isn't re-reviewed after the server bounces. */
export function createFileLedger(filePath: string): PrReviewLedger {
    let map: Record<string, string> = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
                if (/^\d+$/.test(k) && typeof v === 'string') map[k] = v;
            }
        }
    } catch { /* first run / corrupt file — start empty */ }
    const persist = () => {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
        } catch { /* read-only fs — ledger degrades to in-memory */ }
    };
    return {
        get: (n) => map[String(n)],
        set: (n, sha) => { map[String(n)] = sha; persist(); },
        size: () => Object.keys(map).length,
    };
}
