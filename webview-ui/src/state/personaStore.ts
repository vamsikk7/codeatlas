/**
 * personaStore.ts — Issue #706 persona-adaptive UI store.
 *
 * Three personas: 'junior' (least amount of chrome, simplified
 * diagrams), 'pm' (high-level dashboards, hides code-level views),
 * 'power' (today's full UI — default).
 *
 * Tiny vanilla store — no Redux, no Context. Just a module-level value
 * + a Set of listeners + the standard React `useSyncExternalStore`
 * subscription hook. Persists to `localStorage` so the choice survives
 * reload.
 *
 * Components opt in via `usePersona()`; non-component code (route
 * guards, command palette filters) read the static value via
 * `getPersona()`. Both are deliberately cheap so we can pepper the
 * conditional rendering throughout the codebase without performance worry.
 */

import { useSyncExternalStore } from 'react';

export type Persona = 'junior' | 'pm' | 'power';

const STORAGE_KEY = 'codeatlas.persona';
const VALID: ReadonlySet<Persona> = new Set(['junior', 'pm', 'power'] as Persona[]);

function loadInitial(): Persona {
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (raw && VALID.has(raw as Persona)) return raw as Persona;
    } catch { /* SSR / private mode — fall through */ }
    return 'power';
}

let current: Persona = loadInitial();
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) l();
}

export function getPersona(): Persona {
    return current;
}

export function setPersona(next: Persona): void {
    if (!VALID.has(next) || next === current) return;
    current = next;
    try { window.localStorage?.setItem(STORAGE_KEY, next); } catch { /* noop */ }
    emit();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/**
 * React hook — subscribes the calling component to persona changes via
 * `useSyncExternalStore`. SSR-safe: the second argument falls back to
 * `'power'` (the static default) so server-rendered output is stable.
 */
export function usePersona(): Persona {
    return useSyncExternalStore(subscribe, () => current, () => 'power');
}

// ─── Test helpers ───────────────────────────────────────────────────────
// Exposed but not part of the public surface — tests reset state between
// runs via `_resetPersonaForTests()` so localStorage pollution from one
// test doesn't leak into the next.

export function _resetPersonaForTests(value: Persona = 'power'): void {
    current = value;
    try { window.localStorage?.removeItem(STORAGE_KEY); } catch { /* noop */ }
    emit();
}
