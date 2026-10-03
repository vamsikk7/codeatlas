/**
 * PersonaSelector.test.tsx — Issue #706.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PersonaSelector from '../PersonaSelector';
import { _resetPersonaForTests, getPersona, setPersona } from '../../state/personaStore';

describe('PersonaSelector', () => {
    beforeEach(() => {
        _resetPersonaForTests('power');
    });

    it('renders three options with the default power persona active', () => {
        render(<PersonaSelector />);
        expect(screen.getByTestId('persona-option-junior')).toBeTruthy();
        expect(screen.getByTestId('persona-option-pm')).toBeTruthy();
        expect(screen.getByTestId('persona-option-power')).toBeTruthy();
        expect(screen.getByTestId('persona-option-power').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('persona-option-junior').getAttribute('aria-checked')).toBe('false');
    });

    it('click switches the active option + updates the store', () => {
        render(<PersonaSelector />);
        fireEvent.click(screen.getByTestId('persona-option-junior'));
        expect(getPersona()).toBe('junior');
        expect(screen.getByTestId('persona-option-junior').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('persona-option-power').getAttribute('aria-checked')).toBe('false');
    });

    it('persists the choice to localStorage', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        render(<PersonaSelector />);
        fireEvent.click(screen.getByTestId('persona-option-pm'));
        expect(setItem).toHaveBeenCalledWith('codeatlas.persona', 'pm');
        setItem.mockRestore();
    });

    it('clicking the already-active option is a no-op', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        render(<PersonaSelector />);
        fireEvent.click(screen.getByTestId('persona-option-power'));
        expect(setItem).not.toHaveBeenCalled();
        setItem.mockRestore();
    });

    it('setPersona from outside the component updates the rendered state', () => {
        render(<PersonaSelector />);
        // Imperative store update simulates a remote change (e.g. a future
        // command-palette entry that flips persona).
        fireEvent.click(screen.getByTestId('persona-option-junior')); // sanity
        expect(getPersona()).toBe('junior');
        // Now flip via the store API directly. act() flushes the
        // store's listener emit through React's reconciler.
        act(() => { setPersona('pm'); });
        expect(screen.getByTestId('persona-option-pm').getAttribute('aria-checked')).toBe('true');
    });
});
