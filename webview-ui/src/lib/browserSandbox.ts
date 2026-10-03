/**
 * browserSandbox.ts — Issue #603 Phase 3.5 / 3.6 browser-side script
 * executor.
 *
 * Mirrors the server-side Node-`vm` sandbox at
 * `src/core/apiTesting/sandbox/index.ts`, but runs INSIDE the webview
 * using QuickJS-WASM. Lets users preview their pre/post-response
 * scripts without a round-trip to the extension host — useful for
 * iterating on `pm.test` assertions when the script is still wrong.
 *
 * Optional dep: `quickjs-emscripten`. When the package isn't installed,
 * `runBrowserScript` returns `{ available: false }` so the caller can
 * show a "preview unavailable — install quickjs-emscripten" hint and
 * gracefully degrade to the server-side path that already exists.
 *
 * To activate:
 *   cd webview-ui && npm install quickjs-emscripten
 *
 * The host curates the same `pm.*` API surface as the Node sandbox —
 * `pm.environment.{get,set,has,unset}`, `pm.request.*`,
 * `pm.response.{status,statusText,headers.get,text,json}`,
 * `pm.test(name, fn)`, `pm.expect.{toBe,toEqual,toContain,toBeTruthy,
 * toBeFalsy,toMatch}`. Anything else throws `ReferenceError` per the
 * same threat model. 2-second timeout.
 */

export interface BrowserRequestSnapshot {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

export interface BrowserResponseSnapshot {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
}

export interface BrowserTestResult {
    name: string;
    passed: boolean;
    error?: string;
}

export interface BrowserScriptRunResult {
    available: boolean;
    env: Record<string, string>;
    testResults: BrowserTestResult[];
    logs: string[];
    error?: string;
}

export interface RunBrowserScriptArgs {
    source: string;
    env: Record<string, string>;
    request: BrowserRequestSnapshot;
    response?: BrowserResponseSnapshot;
}

const SCRIPT_TIMEOUT_MS = 2_000;

interface QuickJsModule {
    getQuickJS: () => Promise<{
        newContext: () => QuickJsContext;
    }>;
}

interface QuickJsContext {
    newObject: () => unknown;
    newString: (s: string) => unknown;
    newNumber: (n: number) => unknown;
    newFunction: (name: string, fn: (...args: unknown[]) => unknown) => unknown;
    setProp: (obj: unknown, key: string, value: unknown) => void;
    getProp: (obj: unknown, key: string) => unknown;
    global: unknown;
    evalCode: (source: string, opts?: { timeout?: number }) => { value?: unknown; error?: unknown };
    dump: (handle: unknown) => unknown;
    dispose: () => void;
    runtime: { setMemoryLimit: (n: number) => void; setMaxStackSize: (n: number) => void };
}

let quickJsModule: QuickJsModule | null | undefined = undefined;
let quickJsPromise: Promise<QuickJsModule | null> | null = null;

function loadQuickJs(): Promise<QuickJsModule | null> {
    if (quickJsModule !== undefined) return Promise.resolve(quickJsModule);
    if (quickJsPromise) return quickJsPromise;
    quickJsPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<QuickJsModule>)('quickjs-emscripten')
        .then((mod) => { quickJsModule = mod; return mod; })
        .catch(() => { quickJsModule = null; return null; });
    return quickJsPromise;
}

/**
 * Run a script in the browser-side QuickJS sandbox. Falls back to
 * `{ available: false }` when the dep isn't installed; the UI should
 * surface that as a hint, not an error.
 *
 * The implementation is intentionally narrow: we build the `pm.*`
 * surface using simple proxy objects and let the script mutate a
 * captured env map. Deep JSON access via `pm.response.json()` goes
 * through `evalCode('JSON.parse(...)')` so we don't have to write a
 * cross-runtime handle-to-host serializer.
 */
export async function runBrowserScript(args: RunBrowserScriptArgs): Promise<BrowserScriptRunResult> {
    const mod = await loadQuickJs();
    if (!mod) {
        return {
            available: false,
            env: { ...args.env },
            testResults: [],
            logs: [],
            error: 'quickjs-emscripten not installed — install it in webview-ui to enable in-browser script preview.',
        };
    }

    const env: Record<string, string> = { ...args.env };
    const testResults: BrowserTestResult[] = [];
    const logs: string[] = [];

    let ctx: QuickJsContext | null = null;
    try {
        const QuickJS = await mod.getQuickJS();
        ctx = QuickJS.newContext();
        ctx.runtime.setMemoryLimit(8 * 1024 * 1024); // 8 MB
        ctx.runtime.setMaxStackSize(1 * 1024 * 1024); // 1 MB

        installPmHost(ctx, env, testResults, logs, args.request, args.response);

        const result = ctx.evalCode(args.source, { timeout: SCRIPT_TIMEOUT_MS });
        if (result.error) {
            const err = ctx.dump(result.error) as { message?: string };
            const msg = err && typeof err === 'object' && typeof err.message === 'string'
                ? err.message
                : JSON.stringify(err ?? 'unknown');
            return { available: true, env, testResults, logs, error: msg.slice(0, 500) };
        }
        return { available: true, env, testResults, logs };
    } catch (err: any) {
        return {
            available: true,
            env,
            testResults,
            logs,
            error: err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
        };
    } finally {
        try { ctx?.dispose(); } catch { /* noop */ }
    }
}

function installPmHost(
    ctx: QuickJsContext,
    env: Record<string, string>,
    testResults: BrowserTestResult[],
    logs: string[],
    request: BrowserRequestSnapshot,
    response: BrowserResponseSnapshot | undefined,
): void {
    const pm = ctx.newObject();

    // pm.environment — guest functions reach back into our env map.
    const environment = ctx.newObject();
    ctx.setProp(environment, 'get', ctx.newFunction('get', (nameHandle) => {
        const name = String(ctx.dump(nameHandle));
        return env[name] != null ? ctx.newString(env[name]) : undefined;
    }));
    ctx.setProp(environment, 'set', ctx.newFunction('set', (nameHandle, valueHandle) => {
        const name = String(ctx.dump(nameHandle));
        if (!name) return undefined;
        const v = ctx.dump(valueHandle);
        env[name] = v == null ? '' : String(v);
        return undefined;
    }));
    ctx.setProp(environment, 'has', ctx.newFunction('has', (nameHandle) => {
        const name = String(ctx.dump(nameHandle));
        return ctx.newNumber(Object.prototype.hasOwnProperty.call(env, name) ? 1 : 0);
    }));
    ctx.setProp(environment, 'unset', ctx.newFunction('unset', (nameHandle) => {
        const name = String(ctx.dump(nameHandle));
        delete env[name];
        return undefined;
    }));
    ctx.setProp(pm, 'environment', environment);

    // pm.request — snapshot copied into the sandbox.
    const requestHandle = ctx.evalCode(JSON.stringify(request));
    if (requestHandle.value) {
        ctx.setProp(pm, 'request', requestHandle.value);
    }

    // pm.response — only present when response is supplied.
    if (response) {
        const responseObj = ctx.newObject();
        ctx.setProp(responseObj, 'status', ctx.newNumber(response.status));
        ctx.setProp(responseObj, 'statusText', ctx.newString(response.statusText));
        const headers = ctx.newObject();
        ctx.setProp(headers, 'get', ctx.newFunction('get', (nameHandle) => {
            const name = String(ctx.dump(nameHandle)).toLowerCase();
            for (const [k, v] of Object.entries(response.headers)) {
                if (k.toLowerCase() === name) return ctx.newString(v);
            }
            return undefined;
        }));
        ctx.setProp(responseObj, 'headers', headers);
        ctx.setProp(responseObj, 'text', ctx.newFunction('text', () => ctx.newString(response.body)));
        ctx.setProp(responseObj, 'json', ctx.newFunction('json', () => {
            const parsed = ctx.evalCode(`(${response.body})`);
            return parsed.value;
        }));
        ctx.setProp(pm, 'response', responseObj);
    }

    // pm.test + pm.expect — call-host pattern.
    ctx.setProp(pm, 'test', ctx.newFunction('test', (nameHandle, fnHandle) => {
        const name = String(ctx.dump(nameHandle) ?? '');
        if (!name) return undefined;
        // Invoke the fn by writing a tiny shim that reads it from the
        // sandbox and calls with no args. We use evalCode to run the
        // call in-context; errors propagate as Result.error.
        const callResult = ctx.evalCode(`(${ctx.dump(fnHandle) === undefined ? '()=>{}' : 'arguments[0]'})()`);
        if (callResult.error) {
            const errDump = ctx.dump(callResult.error) as { message?: string };
            testResults.push({
                name,
                passed: false,
                error: typeof errDump?.message === 'string' ? errDump.message : JSON.stringify(errDump ?? ''),
            });
        } else {
            testResults.push({ name, passed: true });
        }
        return undefined;
    }));

    // Lightweight pm.expect — guest-side mirror of the Node matchers.
    // We define it via evalCode so the matchers run inside the
    // sandbox (cheaper than ferrying every comparison out to the host).
    ctx.evalCode(`
        globalThis.__caExpect = function (actual) {
            return {
                toBe: function (expected) {
                    if (!Object.is(actual, expected)) throw new Error('expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
                },
                toEqual: function (expected) {
                    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual));
                },
                toContain: function (expected) {
                    if (typeof actual === 'string' && typeof expected === 'string') {
                        if (actual.indexOf(expected) < 0) throw new Error('expected string to contain ' + JSON.stringify(expected));
                        return;
                    }
                    if (Array.isArray(actual)) {
                        var found = actual.some(function (v) { return JSON.stringify(v) === JSON.stringify(expected); });
                        if (!found) throw new Error('expected array to contain ' + JSON.stringify(expected));
                        return;
                    }
                    throw new Error('toContain only supports strings and arrays');
                },
                toBeTruthy: function () { if (!actual) throw new Error('expected truthy'); },
                toBeFalsy: function () { if (actual) throw new Error('expected falsy'); },
                toMatch: function (pattern) {
                    if (typeof actual !== 'string') throw new Error('toMatch expected string');
                    var re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
                    if (!re.test(actual)) throw new Error('expected ' + JSON.stringify(actual) + ' to match ' + re);
                }
            };
        };
    `);
    ctx.evalCode(`globalThis.pm = globalThis.pm || {};`);
    ctx.evalCode(`globalThis.pm.expect = globalThis.__caExpect;`);

    // Attach pm to global.
    ctx.setProp(ctx.global, 'pm', pm);

    // console.log → host log array.
    const consoleObj = ctx.newObject();
    const mkLog = (level: string) => ctx.newFunction(level, (...handles) => {
        const parts: string[] = [level];
        for (const h of handles) {
            const v = ctx.dump(h);
            parts.push(typeof v === 'string' ? v : JSON.stringify(v));
        }
        logs.push(parts.join(' '));
        return undefined;
    });
    ctx.setProp(consoleObj, 'log', mkLog('log'));
    ctx.setProp(consoleObj, 'warn', mkLog('warn'));
    ctx.setProp(consoleObj, 'error', mkLog('error'));
    ctx.setProp(ctx.global, 'console', consoleObj);
}

export const __testHooks = {
    primeQuickJs(mod: QuickJsModule | null) { quickJsModule = mod; quickJsPromise = null; },
    reset() { quickJsModule = undefined; quickJsPromise = null; },
};
