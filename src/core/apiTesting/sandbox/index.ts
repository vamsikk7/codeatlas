/**
 * apiTesting/sandbox/index.ts — Issue #603 Phase 3.5 script executor.
 *
 * Runs user-supplied pre-request + post-response scripts in a tight
 * Node `vm` sandbox. The script sees a curated `pm.*` API surface that
 * covers the practical subset of Postman's runtime — enough to extract
 * fields into env, mutate the next request, and assert on the response,
 * without exposing `require` / `process` / the file system.
 *
 * Phase 3.5 intentionally avoids `quickjs-emscripten` (would add a
 * ~600 KB dep + bundle integration work). Node `vm.runInNewContext`
 * gives us the same isolation primitives we need; the script runs in
 * a fresh context with ONLY the API surface we hand it.
 *
 * Webview integration: the editor is a `<textarea>`; full Monaco lands
 * in a follow-up. Scripts execute SERVER-SIDE only (extension host +
 * standalone Node process) — the webview never `eval`s anything.
 *
 * Supported `pm.*` API:
 *   pm.environment.get(name)             → string | undefined
 *   pm.environment.set(name, value)      — sets env[name] = String(value)
 *   pm.environment.has(name)             → boolean
 *   pm.environment.unset(name)           — deletes env[name]
 *   pm.response.json()                   — parsed JSON body (post-response)
 *   pm.response.text()                   — raw body
 *   pm.response.status                   — number (post-response)
 *   pm.response.headers.get(name)        → string | undefined
 *   pm.request.url / method / body / headers — read-only snapshot
 *   pm.test(name, fn)                    — records a test result
 *   pm.expect(actual).toEqual(expected)
 *   pm.expect(actual).toBe(expected)
 *   pm.expect(actual).toContain(expected)
 *   pm.expect(actual).toBeTruthy()
 *   pm.expect(actual).toBeFalsy()
 *   pm.expect(actual).toMatch(regex)
 *   console.log/.warn/.error           — captured for return
 *
 * Anything else is a `ReferenceError`. The script gets a 2-second
 * timeout (extension host + standalone share the cap).
 */

import * as vm from 'vm';

const SCRIPT_TIMEOUT_MS = 2_000;

export interface ScriptRequestSnapshot {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

export interface ScriptResponseSnapshot {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
}

export interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

export interface ScriptRunResult {
    env: Record<string, string>;
    testResults: TestResult[];
    logs: string[];
    error?: string;
}

export interface RunScriptArgs {
    source: string;
    env: Record<string, string>;
    /** Read-only — the script can inspect but not directly mutate. */
    request: ScriptRequestSnapshot;
    /** Only present for post-response runs. */
    response?: ScriptResponseSnapshot;
}

export function runScript(args: RunScriptArgs): ScriptRunResult {
    const env: Record<string, string> = { ...args.env };
    const testResults: TestResult[] = [];
    const logs: string[] = [];

    const pm = buildPmApi(env, testResults, args.request, args.response);
    const context: Record<string, unknown> = {
        pm,
        console: {
            log:   (...a: unknown[]) => logs.push(['log', ...a].map(formatForLog).join(' ')),
            warn:  (...a: unknown[]) => logs.push(['warn', ...a].map(formatForLog).join(' ')),
            error: (...a: unknown[]) => logs.push(['error', ...a].map(formatForLog).join(' ')),
        },
        JSON,
        Math,
        Date,
        Number, String, Boolean, Array, Object,
    };

    try {
        vm.createContext(context);
        vm.runInContext(args.source, context, {
            timeout: SCRIPT_TIMEOUT_MS,
            displayErrors: true,
        });
        return { env, testResults, logs };
    } catch (err: any) {
        return {
            env,
            testResults,
            logs,
            error: err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
        };
    }
}

function buildPmApi(
    env: Record<string, string>,
    testResults: TestResult[],
    request: ScriptRequestSnapshot,
    response?: ScriptResponseSnapshot,
): Record<string, unknown> {
    return {
        environment: {
            get: (name: string) => env[name],
            set: (name: string, value: unknown) => {
                if (typeof name !== 'string' || !name) return;
                env[name] = value == null ? '' : String(value);
            },
            has: (name: string) => Object.prototype.hasOwnProperty.call(env, name),
            unset: (name: string) => { delete env[name]; },
        },
        request: {
            method: request.method,
            url: request.url,
            headers: { ...request.headers },
            body: request.body,
        },
        response: response ? buildResponseApi(response) : undefined,
        test: (name: string, fn: () => void) => {
            if (typeof name !== 'string' || typeof fn !== 'function') return;
            try {
                fn();
                testResults.push({ name, passed: true });
            } catch (err: any) {
                testResults.push({
                    name,
                    passed: false,
                    error: err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
                });
            }
        },
        expect: (actual: unknown) => buildExpectMatchers(actual),
    };
}

function buildResponseApi(response: ScriptResponseSnapshot): Record<string, unknown> {
    let parsedJson: unknown | undefined;
    let parsedJsonAttempted = false;
    return {
        status: response.status,
        statusText: response.statusText,
        headers: {
            get: (name: string) => {
                const lower = name.toLowerCase();
                for (const [k, v] of Object.entries(response.headers)) {
                    if (k.toLowerCase() === lower) return v;
                }
                return undefined;
            },
        },
        text: () => response.body,
        json: () => {
            if (!parsedJsonAttempted) {
                parsedJsonAttempted = true;
                try { parsedJson = JSON.parse(response.body); }
                catch { parsedJson = undefined; }
            }
            return parsedJson;
        },
    };
}

interface ExpectMatchers {
    toBe: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toContain: (expected: unknown) => void;
    toBeTruthy: () => void;
    toBeFalsy: () => void;
    toMatch: (pattern: RegExp | string) => void;
}

function buildExpectMatchers(actual: unknown): ExpectMatchers {
    return {
        toBe: (expected) => {
            if (!Object.is(actual, expected)) {
                throw new Error(`expected ${formatForLog(expected)} but got ${formatForLog(actual)}`);
            }
        },
        toEqual: (expected) => {
            if (!deepEqual(actual, expected)) {
                throw new Error(`expected ${formatForLog(expected)} but got ${formatForLog(actual)}`);
            }
        },
        toContain: (expected) => {
            if (typeof actual === 'string' && typeof expected === 'string') {
                if (!actual.includes(expected)) {
                    throw new Error(`expected string ${formatForLog(actual)} to contain ${formatForLog(expected)}`);
                }
                return;
            }
            if (Array.isArray(actual)) {
                if (!actual.some(v => deepEqual(v, expected))) {
                    throw new Error(`expected array to contain ${formatForLog(expected)}`);
                }
                return;
            }
            throw new Error(`toContain only supports strings and arrays`);
        },
        toBeTruthy: () => {
            if (!actual) throw new Error(`expected truthy, got ${formatForLog(actual)}`);
        },
        toBeFalsy: () => {
            if (actual) throw new Error(`expected falsy, got ${formatForLog(actual)}`);
        },
        toMatch: (pattern) => {
            if (typeof actual !== 'string') {
                throw new Error(`toMatch expected string, got ${typeof actual}`);
            }
            // Don't use `instanceof RegExp` — when the script creates a
            // RegExp via literal (`/foo/`), the resulting object lives in
            // the sandbox's realm and fails the prototype check against
            // the host's `RegExp`. Duck-type via `.source` instead.
            const isRegex = pattern && typeof pattern === 'object'
                && typeof (pattern as { source?: unknown }).source === 'string';
            const re = isRegex
                ? new RegExp((pattern as RegExp).source, (pattern as RegExp).flags || undefined)
                : new RegExp(String(pattern));
            if (!re.test(actual)) {
                throw new Error(`expected ${formatForLog(actual)} to match ${re}`);
            }
        },
    };
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        const ka = Object.keys(a as object).sort();
        const kb = Object.keys(b as object).sort();
        if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
        return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
    }
    return false;
}

function formatForLog(v: unknown): string {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}
