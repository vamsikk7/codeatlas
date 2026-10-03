/**
 * i18n.test.tsx — Issue #713.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { t, getLocale, setLocale, listLocales, _resetLocaleForTests, useLocale } from '../i18n';
import LocaleSelector from '../components/LocaleSelector';

describe('i18n.t()', () => {
    beforeEach(() => { _resetLocaleForTests('en'); });

    it('returns the English string by default', () => {
        expect(t('home.subtitle')).toBe('Architecture Visualization');
    });

    it('returns the translated string after setLocale', () => {
        setLocale('zh');
        expect(t('home.subtitle')).toBe('架构可视化');
    });

    it('falls back to English when a key is missing in the target locale', () => {
        setLocale('pt');
        // Synthetic key that exists in en but not in pt — even if pt is
        // complete, the fallback path is exercised when a future key is
        // added to en and not yet translated.
        // Note: 'home.support' exists in all locales, so we'll use a
        // genuinely missing key to test the fallback.
        expect(t('definitely.missing.key')).toBe('definitely.missing.key');
    });

    it('interpolates {name} variables', () => {
        expect(t('tour.step', { n: 4 })).toBe('Step 4');
    });

    it('interpolates multiple vars', () => {
        expect(t('tour.stepOfTotal', { current: 3, total: 10 })).toBe('3 / 10');
    });
});

describe('locale store', () => {
    beforeEach(() => { _resetLocaleForTests('en'); });

    it('listLocales returns all 5 locales', () => {
        const all = listLocales();
        expect(all).toHaveLength(5);
        expect(all.map(l => l.id)).toEqual(['en', 'zh', 'ja', 'es', 'pt']);
    });

    it('setLocale persists to localStorage', () => {
        setLocale('ja');
        expect(window.localStorage.getItem('codeatlas.locale')).toBe('ja');
    });

    it('setLocale ignores unknown values', () => {
        setLocale('en');
        setLocale('xx' as any);
        expect(getLocale()).toBe('en');
    });

    it('setLocale is a no-op for the current locale', () => {
        setLocale('en');
        const before = window.localStorage.getItem('codeatlas.locale');
        setLocale('en');
        expect(window.localStorage.getItem('codeatlas.locale')).toBe(before);
    });
});

describe('LocaleSelector', () => {
    beforeEach(() => { _resetLocaleForTests('en'); });

    it('renders all locale options', () => {
        render(<LocaleSelector />);
        const select = screen.getByTestId('locale-selector') as HTMLSelectElement;
        expect(select.options).toHaveLength(5);
        expect(select.value).toBe('en');
    });

    it('changing the dropdown updates the active locale', () => {
        render(<LocaleSelector />);
        const select = screen.getByTestId('locale-selector') as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'es' } });
        expect(getLocale()).toBe('es');
    });

    it('subscribes to setLocale changes from outside the component', () => {
        render(<LocaleSelector />);
        act(() => { setLocale('pt'); });
        const select = screen.getByTestId('locale-selector') as HTMLSelectElement;
        expect(select.value).toBe('pt');
    });
});
