/**
 * LearnPanel.test.tsx — Issue #708.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { LearnPanel, LearnButton } from '../LearnPanel';
import { _resetPersonaForTests, setPersona } from '../../state/personaStore';

describe('LearnPanel', () => {
    beforeEach(() => { _resetPersonaForTests('power'); });

    it('renders nothing when closed', () => {
        const { container } = render(
            <LearnPanel helpKey="map" open={false} onClose={() => {}} />,
        );
        expect(container.querySelector('[data-testid="learn-panel"]')).toBeNull();
    });

    it('renders the title + summary + body for a known helpKey', () => {
        render(<LearnPanel helpKey="map" open={true} onClose={() => {}} />);
        expect(screen.getByText('Knowledge Map')).toBeTruthy();
        expect(screen.getByText(/Single-canvas overview/i)).toBeTruthy();
    });

    it('shows the powerExtra paragraph for Power persona', () => {
        render(<LearnPanel helpKey="map" open={true} onClose={() => {}} />);
        expect(screen.getByText(/Under the hood:/i)).toBeTruthy();
    });

    it('hides the powerExtra paragraph for Junior persona', () => {
        act(() => { setPersona('junior'); });
        render(<LearnPanel helpKey="map" open={true} onClose={() => {}} />);
        expect(screen.queryByText(/Under the hood:/i)).toBeNull();
    });

    it('falls back to a "no help" message for unknown helpKey', () => {
        render(<LearnPanel helpKey="not-a-view" open={true} onClose={() => {}} />);
        expect(screen.getByText(/No help available/i)).toBeTruthy();
    });

    it('close button fires the onClose callback', () => {
        const onClose = vi.fn();
        render(<LearnPanel helpKey="map" open={true} onClose={onClose} />);
        fireEvent.click(screen.getByLabelText('Close learn panel'));
        expect(onClose).toHaveBeenCalled();
    });

    it('Escape key fires onClose while the panel is open', () => {
        const onClose = vi.fn();
        render(<LearnPanel helpKey="map" open={true} onClose={onClose} />);
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(onClose).toHaveBeenCalled();
    });

    it('Escape is a no-op when the panel is closed', () => {
        const onClose = vi.fn();
        render(<LearnPanel helpKey="map" open={false} onClose={onClose} />);
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('LearnButton', () => {
    it('renders a ? affordance with correct ARIA label', () => {
        render(<LearnButton onClick={() => {}} />);
        const btn = screen.getByLabelText('Open learn panel');
        expect(btn.textContent).toBe('?');
    });

    it('click fires the supplied callback', () => {
        const onClick = vi.fn();
        render(<LearnButton onClick={onClick} />);
        fireEvent.click(screen.getByLabelText('Open learn panel'));
        expect(onClick).toHaveBeenCalled();
    });
});
