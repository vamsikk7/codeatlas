import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TextPromptModal from '../TextPromptModal';

// BUG-EXPLORE-11: in-webview replacement for native window.prompt() (which
// froze the browser-served webview / no-op'd in VS Code).
describe('TextPromptModal (BUG-EXPLORE-11)', () => {
    it('renders a NON-native input (no window.prompt) and submits typed text', () => {
        const onSubmit = vi.fn();
        render(<TextPromptModal title="Add comment" onSubmit={onSubmit} onCancel={vi.fn()} submitLabel="Add comment" />);
        expect(screen.getByTestId('text-prompt-modal')).toBeTruthy();
        const input = screen.getByTestId('text-prompt-input');
        fireEvent.change(input, { target: { value: 'looks good' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
        expect(onSubmit).toHaveBeenCalledWith('looks good');
    });
    it('does not submit empty/whitespace text', () => {
        const onSubmit = vi.fn();
        render(<TextPromptModal title="Save chain" onSubmit={onSubmit} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByTestId('text-prompt-input'), { target: { value: '   ' } });
        fireEvent.keyDown(screen.getByTestId('text-prompt-input'), { key: 'Enter' });
        expect(onSubmit).not.toHaveBeenCalled();
    });
    it('cancels on Escape', () => {
        const onCancel = vi.fn();
        render(<TextPromptModal title="x" onSubmit={vi.fn()} onCancel={onCancel} />);
        fireEvent.keyDown(screen.getByTestId('text-prompt-input'), { key: 'Escape' });
        expect(onCancel).toHaveBeenCalled();
    });
    it('submits on Enter (single-line)', () => {
        const onSubmit = vi.fn();
        render(<TextPromptModal title="Save chain" onSubmit={onSubmit} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByTestId('text-prompt-input'), { target: { value: 'my-chain' } });
        fireEvent.keyDown(screen.getByTestId('text-prompt-input'), { key: 'Enter' });
        expect(onSubmit).toHaveBeenCalledWith('my-chain');
    });
});
