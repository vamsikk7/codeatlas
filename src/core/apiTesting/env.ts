/**
 * apiTesting/env.ts — Issue #602 Phase 2 environment variable
 * substitution.
 *
 * Mustache-style `{{var}}` substitution against a flat `Record<string,
 * string>` map. Used by the request executor (the Relay layer) to
 * resolve URLs, headers, and request bodies just before sending.
 *
 * Substitution is iterative — references can reference other refs.
 * Bounded at `MAX_DEPTH` iterations to defend against accidental
 * cycles (`baseUrl = "{{baseUrl}}/x"`).
 *
 * Unknown variables are LEFT IN PLACE (`{{missing}}`) so the caller
 * sees the raw template + can warn the user. This matches the
 * Hoppscotch convention and avoids silent header injection.
 */

const MAX_DEPTH = 10;
const VAR_RE = /\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g;

export function applyEnvVars(input: string, env: Record<string, string>): string {
    if (!input || input.indexOf('{{') < 0) return input;
    let out = input;
    for (let i = 0; i < MAX_DEPTH; i++) {
        let changed = false;
        out = out.replace(VAR_RE, (full, name) => {
            const v = env[name];
            if (typeof v !== 'string') return full; // leave in place
            if (v === full) return full;            // direct self-ref guard
            changed = true;
            return v;
        });
        if (!changed) break;
    }
    return out;
}

/**
 * Parse `key=value` lines into a flat env map. Used by the webview to
 * convert a user-edited textarea into the request executor's input.
 *
 *   - Lines starting with `#` are ignored.
 *   - Blank lines are ignored.
 *   - The first `=` per line is the separator; the rest of the line
 *     becomes the value (so `=` may appear in values).
 *   - Surrounding whitespace is trimmed.
 *
 * Returns the parsed map plus the count of malformed lines so the UI
 * can surface a "skipped 3 lines" hint.
 */
export function parseEnvLines(text: string): { env: Record<string, string>; skipped: number } {
    const env: Record<string, string> = {};
    let skipped = 0;
    if (!text) return { env, skipped };
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) {
            skipped++;
            continue;
        }
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_$][\w$.-]*$/.test(key)) {
            skipped++;
            continue;
        }
        env[key] = line.slice(eq + 1).trim();
    }
    return { env, skipped };
}

/**
 * Apply env substitution to every value of a header / param map. Used
 * by the relay before sending the request.
 */
export function applyEnvToRecord(
    record: Record<string, string>,
    env: Record<string, string>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) {
        out[k] = applyEnvVars(v, env);
    }
    return out;
}
