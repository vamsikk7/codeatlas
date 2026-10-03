/**
 * apiTesting/runChain.ts — Issue #603 Phase 3 collection chain runner.
 *
 * Runs a list of steps sequentially against the Phase 2 relay
 * (`executeRequest`), accumulating env vars between them via the
 * Phase 3 extractor (`extract.ts`). Each step can:
 *
 *   - Reference previous env vars via `{{var}}` in URL / headers /
 *     body / bearerToken (the relay handles the substitution).
 *   - Save fields from its own response into env via the optional
 *     `extract` map: `{ envVarName: { scope, path } }`.
 *   - Assert on the response via the `assert` field: status range,
 *     non-empty body check, header presence.
 *
 * Failure handling: by default the runner continues after a failure
 * so the user sees per-step results across the entire chain. Pass
 * `stopOnFirstFailure: true` to bail at the first non-2xx (or assert
 * failure).
 */

import { executeRequest, type SendRequestResponse } from './relay';
import { extractValue, tryParseJsonBody, type ExtractScope } from './extract';
import { runScript, type TestResult } from './sandbox';

export interface ChainExtract {
    /** Where to read from. */
    scope: ExtractScope;
    /** JSONPath-lite (see extract.ts). */
    path: string;
}

export interface ChainAssertions {
    /** Allowed status code range, e.g. `[200, 299]`. */
    statusBetween?: [number, number];
    /** Specific status the response must carry. */
    statusEquals?: number;
    /** Response body must include this substring. */
    bodyContains?: string;
    /** Response body must NOT include this substring. */
    bodyNotContains?: string;
    /** Header must be present (case-insensitive). */
    hasHeader?: string;
}

export interface ChainStep {
    /** Stable id — surfaces in the per-step result row. */
    id: string;
    /** Display label (e.g. "POST /api/users/login"). */
    label?: string;
    method: string;
    url: string;
    /**
     * ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — in multi-repo workspaces, identifies the
     * repo this step targets. When set together with a `resolveBaseUrl`
     * callback on `RunChainArgs`, a relative `url` (starts with `/`)
     * gets the repo's dev base URL prefixed automatically. Optional —
     * single-repo workspaces leave this unset.
     */
    repoId?: string;
    headers?: Record<string, string>;
    body?: string;
    bearerToken?: string;
    apiKey?: string;
    apiKeyHeader?: string;
    /** Map of env-var-to-set → extraction recipe. Applied AFTER the
     *  response is received, BEFORE the next step runs. */
    extract?: Record<string, ChainExtract>;
    /** Assertions on the response shape. Failures don't abort the
     *  chain unless `stopOnFirstFailure: true`. */
    assert?: ChainAssertions;
    /** Phase 3.5 — optional sandboxed JS script that runs BEFORE the
     *  request fires. Has access to `pm.environment.*` + `pm.request.*`. */
    preRequestScript?: string;
    /** Phase 3.5 — optional sandboxed JS script that runs AFTER the
     *  response is received. Has access to `pm.environment.*` +
     *  `pm.request.*` + `pm.response.*` + `pm.test()` + `pm.expect()`. */
    postResponseScript?: string;
}

export interface ChainStepResult {
    id: string;
    label?: string;
    method: string;
    url: string;
    /** The substituted URL the relay actually requested. */
    resolvedUrl: string;
    response: SendRequestResponse;
    /** Successful extractions are mirrored here AND propagate to env. */
    extracted: Record<string, unknown>;
    /** Assertion failures — empty array when all assertions pass. */
    assertFailures: string[];
    /** Phase 3.5 — results from any `pm.test(...)` calls in the
     *  post-response script. Failed `pm.test` results count toward
     *  the step's `failed` outcome. */
    testResults: TestResult[];
    /** Phase 3.5 — captured `console.log` / `console.warn` /
     *  `console.error` calls from either script. */
    scriptLogs: string[];
    /** Phase 3.5 — script-level error (timeout / ReferenceError /
     *  thrown). Counts as `failed`. */
    scriptError?: string;
    /** Top-level outcome: 'passed' / 'failed' / 'errored'. */
    outcome: 'passed' | 'failed' | 'errored';
}

export interface RunChainArgs {
    steps: ChainStep[];
    initialEnv?: Record<string, string>;
    /** Stop after the first failure / errored step. Default `false`. */
    stopOnFirstFailure?: boolean;
    /**
     * ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — per-repo base URL resolver. When a step
     * carries `repoId` AND its `url` is relative (starts with `/`), the
     * runner prefixes `resolveBaseUrl(repoId)` to the URL before request
     * dispatch. Single-repo workspaces and absolute URLs ignore this
     * callback entirely.
     */
    resolveBaseUrl?: (repoId: string) => string;
    /** #887 — allow loopback/private hosts (NOT metadata/link-local). The
     *  user-initiated workbench chain run passes true; the MCP `run_api_chain`
     *  tool leaves it false so an injected agent can't SSRF internal hosts. */
    allowPrivateHosts?: boolean;
}

export interface RunChainResult {
    steps: ChainStepResult[];
    /** Env after all steps that ran. Reflects every successful extraction. */
    finalEnv: Record<string, string>;
    passed: number;
    failed: number;
    errored: number;
    /** True when the runner bailed because of `stopOnFirstFailure`. */
    aborted: boolean;
}

export async function runChain(args: RunChainArgs): Promise<RunChainResult> {
    const env: Record<string, string> = { ...(args.initialEnv ?? {}) };
    const stepResults: ChainStepResult[] = [];
    let passed = 0;
    let failed = 0;
    let errored = 0;
    let aborted = false;

    // ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — resolve per-step base URL when the step
    // carries a repoId. Relative URLs (start with `/`) require a non-
    // empty base URL from the resolver; missing/empty refuses dispatch
    // and surfaces a clear errored row. Absolute URLs bypass entirely.
    const applyRepoBase = (step: ChainStep): { url: string; error?: string } => {
        if (!step.repoId) return { url: step.url };
        if (!step.url.startsWith('/')) return { url: step.url };
        const raw = args.resolveBaseUrl ? args.resolveBaseUrl(step.repoId) : '';
        const base = (raw ?? '').replace(/\/+$/, '');
        if (!base) {
            return {
                url: step.url,
                error:
                    `Cross-repo step '${step.id}' targets repo '${step.repoId}' but no dev base URL is configured. ` +
                    `Set it under workspace settings → Repo dev URLs.`,
            };
        }
        return { url: base + step.url };
    };

    for (const step of args.steps) {
        const scriptLogs: string[] = [];
        let scriptError: string | undefined;
        const testResults: TestResult[] = [];
        const resolved = applyRepoBase(step);
        const stepUrl = resolved.url;

        // Refuse dispatch when the per-repo base URL is missing/empty —
        // emit a clear errored row and continue (or abort on
        // stopOnFirstFailure).
        if (resolved.error) {
            stepResults.push({
                id: step.id,
                label: step.label,
                method: step.method,
                url: step.url,
                resolvedUrl: step.url,
                response: {
                    status: 0,
                    statusText: '',
                    headers: {},
                    body: '',
                    durationMs: 0,
                    truncated: false,
                    error: resolved.error,
                },
                extracted: {},
                assertFailures: [],
                testResults: [],
                scriptLogs: [],
                scriptError: undefined,
                outcome: 'errored',
            });
            errored++;
            if (args.stopOnFirstFailure) { aborted = true; break; }
            continue;
        }

        // ── Phase 3.5: pre-request script ───────────────────────────
        const preRequest = {
            method: step.method,
            url: substituteOnce(stepUrl, env),
            headers: step.headers ? { ...step.headers } : {},
            body: step.body,
        };
        if (step.preRequestScript) {
            const pre = runScript({
                source: step.preRequestScript,
                env,
                request: preRequest,
            });
            // Pre-request scripts only mutate env; we copy that back.
            Object.assign(env, pre.env);
            scriptLogs.push(...pre.logs);
            testResults.push(...pre.testResults);
            if (pre.error) scriptError = pre.error;
        }

        const response = await executeRequest({
            method: step.method,
            url: stepUrl,
            headers: step.headers,
            body: step.body,
            env,
            bearerToken: step.bearerToken,
            apiKey: step.apiKey,
            apiKeyHeader: step.apiKeyHeader,
            allowPrivateHosts: args.allowPrivateHosts, // #887
        });
        const resolvedUrl = substituteOnce(stepUrl, env);

        const extracted: Record<string, unknown> = {};
        if (step.extract && response.status >= 200 && response.status < 400) {
            const parsedJson = tryParseJsonBody(response.body);
            for (const [envName, recipe] of Object.entries(step.extract)) {
                const value = extractValue(recipe.path, recipe.scope, {
                    body: recipe.scope === 'json' ? parsedJson : undefined,
                    headers: response.headers,
                    status: response.status,
                });
                if (value !== undefined) {
                    extracted[envName] = value;
                    // Only stringifiable scalars / JSON-encodable structures
                    // propagate to env (env is `Record<string, string>`).
                    env[envName] = typeof value === 'string' ? value : JSON.stringify(value);
                }
            }
        }

        // ── Phase 3.5: post-response script ─────────────────────────
        if (step.postResponseScript && !response.error) {
            const post = runScript({
                source: step.postResponseScript,
                env,
                request: preRequest,
                response: {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                    body: response.body,
                },
            });
            Object.assign(env, post.env);
            scriptLogs.push(...post.logs);
            testResults.push(...post.testResults);
            if (post.error && !scriptError) scriptError = post.error;
        }

        const assertFailures = step.assert ? checkAssertions(step.assert, response) : [];
        const failedTests = testResults.filter(t => !t.passed);
        const ok = response.status >= 200 && response.status < 400;
        let outcome: ChainStepResult['outcome'];
        if (response.error) { outcome = 'errored'; errored++; }
        else if (!ok || assertFailures.length > 0 || failedTests.length > 0 || scriptError) {
            outcome = 'failed'; failed++;
        }
        else { outcome = 'passed'; passed++; }

        stepResults.push({
            id: step.id,
            label: step.label,
            method: step.method,
            url: step.url,
            resolvedUrl,
            response,
            extracted,
            assertFailures,
            testResults,
            scriptLogs,
            scriptError,
            outcome,
        });

        if (args.stopOnFirstFailure && outcome !== 'passed') {
            aborted = true;
            break;
        }
    }

    return {
        steps: stepResults,
        finalEnv: env,
        passed,
        failed,
        errored,
        aborted,
    };
}

function checkAssertions(a: ChainAssertions, res: SendRequestResponse): string[] {
    const failures: string[] = [];
    if (a.statusEquals !== undefined && res.status !== a.statusEquals) {
        failures.push(`status expected ${a.statusEquals}, got ${res.status}`);
    }
    if (a.statusBetween) {
        const [lo, hi] = a.statusBetween;
        if (res.status < lo || res.status > hi) {
            failures.push(`status expected in ${lo}..${hi}, got ${res.status}`);
        }
    }
    if (a.bodyContains && !res.body.includes(a.bodyContains)) {
        failures.push(`body missing substring "${a.bodyContains}"`);
    }
    if (a.bodyNotContains && res.body.includes(a.bodyNotContains)) {
        failures.push(`body contains forbidden substring "${a.bodyNotContains}"`);
    }
    if (a.hasHeader) {
        const lower = a.hasHeader.toLowerCase();
        const found = Object.keys(res.headers).some(k => k.toLowerCase() === lower);
        if (!found) failures.push(`header "${a.hasHeader}" not present`);
    }
    return failures;
}

function substituteOnce(template: string, env: Record<string, string>): string {
    return template.replace(/\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g, (full, name) => env[name] ?? full);
}
