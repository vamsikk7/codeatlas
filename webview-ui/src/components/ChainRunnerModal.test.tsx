/**
 * ChainRunnerModal.test.tsx — #914 (per-step extract/assert editor + save/load).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ChainRunnerModal from './ChainRunnerModal';

const EP = (id: string, method: string, route: string): any => ({ id, method, route, handlerName: 'h', filePath: 'a.ts' });

function setup(postMessage = vi.fn()) {
    render(
        <ChainRunnerModal
            available={[EP('e1', 'POST', '/login'), EP('e2', 'GET', '/me')]}
            envText=""
            postMessage={postMessage}
            result={null}
            onCancel={() => {}}
        />,
    );
    return postMessage;
}

describe('#914 — Chain Runner extract/assert editor + save/load', () => {
    beforeEach(() => { localStorage.clear(); });
    afterEach(() => cleanup());

    it('a step gets a per-step extract/assert editor that posts the recipe on run', () => {
        const post = setup();
        // Add the login step, open its editor.
        fireEvent.click(screen.getByRole('button', { name: '+ Add step' }));
        fireEvent.click(screen.getByText('/login'));
        fireEvent.click(screen.getByTestId('chain-step-edit-0'));
        const editor = screen.getByTestId('chain-step-editor');
        expect(editor).toBeDefined();
        // Fill extract: token ← json $.token.
        fireEvent.blur(screen.getByLabelText('Extract variable name'), { target: { value: 'token' } });
        fireEvent.blur(screen.getByLabelText('Extract path'), { target: { value: '$.token' } });
        fireEvent.blur(screen.getByLabelText('Assert status equals'), { target: { value: '200' } });
        // Run → the posted chain carries the extract + assert.
        fireEvent.click(screen.getByText(/Run chain/));
        const runMsg = post.mock.calls.map(c => c[0]).find((m: any) => m.type === 'runChain');
        expect(runMsg).toBeTruthy();
        expect(runMsg.steps[0].extract).toEqual({ token: { scope: 'json', path: '$.token' } });
        expect(runMsg.steps[0].assert).toEqual({ statusEquals: 200 });
    });

    it('saves a chain to the collection store and reloads it', () => {
        setup();
        fireEvent.click(screen.getByRole('button', { name: '+ Add step' }));
        fireEvent.click(screen.getByText('/login'));
        // Save under a name via the in-webview modal (BUG-EXPLORE-11 — no native prompt()).
        fireEvent.click(screen.getByTestId('chain-save'));
        fireEvent.change(screen.getByTestId('text-prompt-input'), { target: { value: 'Login flow' } });
        fireEvent.keyDown(screen.getByTestId('text-prompt-input'), { key: 'Enter' });
        // Persisted to localStorage.
        const saved = JSON.parse(localStorage.getItem('codeatlas:savedChains') || '[]');
        expect(saved).toHaveLength(1);
        expect(saved[0].name).toBe('Login flow');
        expect(saved[0].steps).toHaveLength(1);
        // A load dropdown now exists.
        expect(screen.getByTestId('chain-load')).toBeDefined();
    });

    it('does not save when the save modal is cancelled', () => {
        setup();
        fireEvent.click(screen.getByRole('button', { name: '+ Add step' }));
        fireEvent.click(screen.getByText('/login'));
        fireEvent.click(screen.getByTestId('chain-save'));
        fireEvent.keyDown(screen.getByTestId('text-prompt-input'), { key: 'Escape' });
        expect(localStorage.getItem('codeatlas:savedChains')).toBeNull();
    });
});
