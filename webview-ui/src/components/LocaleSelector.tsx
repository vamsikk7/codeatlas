/**
 * LocaleSelector.tsx — Issue #713 language switcher.
 *
 * Dropdown next to the theme toggle / PersonaSelector. Reads the
 * active locale via `useLocale()`; commits via `setLocale`. Persists
 * to localStorage; survives reload.
 */

import React from 'react';
import { listLocales, setLocale, useLocale, type Locale } from '../i18n';

export function LocaleSelector() {
    const current = useLocale();
    const options = listLocales();
    return (
        <select
            aria-label="Language"
            data-testid="locale-selector"
            value={current}
            onChange={(e) => setLocale(e.target.value as Locale)}
            style={{
                fontSize: 11,
                padding: '3px 6px',
                borderRadius: 6,
                border: '1px solid var(--ca-border)',
                background: 'transparent',
                color: 'var(--ca-text-muted)',
                cursor: 'pointer',
            }}
        >
            {options.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
            ))}
        </select>
    );
}

export default LocaleSelector;
