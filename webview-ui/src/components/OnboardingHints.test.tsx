/**
 * OnboardingHints.test.tsx — #919
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LayerLegend, ModelExplainer, LAYER_LEGEND } from './OnboardingHints';

describe('#919 — LayerLegend', () => {
    it('renders the one-liner for each known layer mode', () => {
        for (const mode of ['microservice', 'feature', 'api-list', 'sequence', 'file', 'flow', 'map']) {
            const { unmount } = render(<LayerLegend mode={mode} />);
            const el = screen.getByTestId('layer-legend');
            expect(el.textContent).toBe(LAYER_LEGEND[mode]);
            expect(el.textContent!.length).toBeGreaterThan(10);
            unmount();
        }
    });

    it('renders nothing for an unknown mode', () => {
        render(<LayerLegend mode="tour" />);
        expect(screen.queryByTestId('layer-legend')).toBeNull();
    });
});

describe('#919 — ModelExplainer (first-run, dismissable)', () => {
    beforeEach(() => { localStorage.clear(); });

    it('renders on first run with the canvas/lens/anchors model', () => {
        render(<ModelExplainer />);
        const el = screen.getByTestId('model-explainer');
        expect(el.textContent).toMatch(/Layers are the canvas/i);
        expect(el.textContent).toMatch(/Overlays are the lens/i);
        expect(el.textContent).toMatch(/Anchors are the join key/i);
    });

    it('dismissal hides it and persists across remounts (localStorage)', () => {
        const { unmount } = render(<ModelExplainer />);
        fireEvent.click(screen.getByTestId('model-explainer-dismiss'));
        expect(screen.queryByTestId('model-explainer')).toBeNull();
        unmount();
        // Remount: stays dismissed.
        render(<ModelExplainer />);
        expect(screen.queryByTestId('model-explainer')).toBeNull();
    });

    it('does not render when already seen', () => {
        localStorage.setItem('codeatlas:modelExplainerSeen', '1');
        render(<ModelExplainer />);
        expect(screen.queryByTestId('model-explainer')).toBeNull();
    });
});
