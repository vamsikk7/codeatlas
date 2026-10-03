/**
 * i18n.ts — Issue #713 tiny `t()` helper.
 *
 * Deliberately avoids `react-i18next` for the MVP — the dependency
 * carries a measurable bundle weight and we don't yet have a
 * non-English user base. This module ships a 30-line equivalent that
 * covers the only feature we need: look up a key in the active locale,
 * fall back to English, return the key itself when no translation
 * exists (so missing keys are visible during dev).
 *
 * Five locales ship with English source-of-truth + four translations.
 * Adding a locale = add a JSON file + register it below; no schema
 * change, no React change.
 */

import en from './locales/en.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import { useSyncExternalStore } from 'react';

export type Locale = 'en' | 'zh' | 'ja' | 'es' | 'pt';

const STORAGE_KEY = 'codeatlas.locale';
const STRINGS: Record<Locale, Record<string, string>> = {
    en: en as Record<string, string>,
    zh: zh as Record<string, string>,
    ja: ja as Record<string, string>,
    es: es as Record<string, string>,
    pt: pt as Record<string, string>,
};

const VALID: ReadonlySet<Locale> = new Set<Locale>(['en', 'zh', 'ja', 'es', 'pt']);

function loadInitial(): Locale {
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (raw && VALID.has(raw as Locale)) return raw as Locale;
        const browser = (navigator?.language ?? '').slice(0, 2).toLowerCase();
        if (VALID.has(browser as Locale)) return browser as Locale;
    } catch { /* SSR / private mode */ }
    return 'en';
}

let current: Locale = loadInitial();
const listeners = new Set<() => void>();
function emit(): void { for (const l of listeners) l(); }

export function getLocale(): Locale {
    return current;
}

export function setLocale(next: Locale): void {
    if (!VALID.has(next) || next === current) return;
    current = next;
    try { window.localStorage?.setItem(STORAGE_KEY, next); } catch { /* noop */ }
    emit();
}

/**
 * Look up a string by key. Falls back to English when the active
 * locale doesn't have the key; returns the key verbatim when even
 * English doesn't have it (so missing-translation bugs surface
 * visually during dev).
 *
 * Interpolation: `t('greeting', { name: 'Alice' })` replaces `{name}`
 * in the resolved string. Keeps the helper tiny + dependency-free.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    const localized = STRINGS[current]?.[key];
    const fallback = STRINGS.en?.[key];
    let template = localized ?? fallback ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return template;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/**
 * React hook — re-renders the subscribed component when the locale
 * changes. Use this in any component that calls `t()` so locale flips
 * propagate without a page reload.
 */
export function useLocale(): Locale {
    return useSyncExternalStore(subscribe, () => current, () => 'en');
}

/** Lists locales available for the LocaleSelector to render. */
export function listLocales(): ReadonlyArray<{ id: Locale; label: string }> {
    return [
        { id: 'en', label: 'English' },
        { id: 'zh', label: '中文' },
        { id: 'ja', label: '日本語' },
        { id: 'es', label: 'Español' },
        { id: 'pt', label: 'Português' },
    ];
}

// ─── Test helpers ────────────────────────────────────────────────────────────

export function _resetLocaleForTests(value: Locale = 'en'): void {
    current = value;
    try { window.localStorage?.removeItem(STORAGE_KEY); } catch { /* noop */ }
    emit();
}
