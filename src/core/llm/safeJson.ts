/**
 * safeJson.ts — #891 prototype-pollution-safe JSON parsing for LLM output.
 *
 * LLM responses are untrusted input (a hostile model, or — compounding #885 — a
 * malicious custom endpoint) and were `JSON.parse`d directly across the review /
 * naming / NL-query paths, then spread into records. A response shaped like
 * `{"__proto__": {"polluted": 1}}` or `{"constructor": {"prototype": {…}}}` could
 * pollute `Object.prototype`. The state-load path already strips these
 * (`snapshotStore.stripProtoDeep`); this is the equivalent guard for LLM JSON.
 *
 * Implementation: a `JSON.parse` reviver that drops the dangerous keys. Returning
 * `undefined` from a reviver deletes the key, and a JSON `"__proto__"` member is
 * created as an OWN property (not an actual prototype setter), so removing it in
 * the reviver fully neutralizes the vector without a second deep walk.
 */

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function protoSafeReviver(key: string, value: unknown): unknown {
    if (DANGEROUS_KEYS.has(key)) return undefined;
    return value;
}

/**
 * `JSON.parse` with the prototype-pollution keys stripped. Throws on invalid
 * JSON exactly like `JSON.parse` — callers keep their existing try/catch.
 */
export function parseLlmJson<T = unknown>(text: string): T {
    return JSON.parse(text, protoSafeReviver) as T;
}
