/**
 * AiReviewScopePicker.test.tsx — ADR-034 Phase G Pass 3 (#792).
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AiReviewScopePicker, { type PickedScope } from '../AiReviewScopePicker';

describe('AiReviewScopePicker — single-repo (no workspace)', () => {
    it('renders the three flat scope options', () => {
        render(<AiReviewScopePicker onPick={() => {}} />);
        expect(screen.getByText('All entry points')).toBeTruthy();
        expect(screen.getByText('Changed only')).toBeTruthy();
        expect(screen.getByText('Selected entry point')).toBeTruthy();
    });

    it('does NOT render workspace / per-repo options when repos is empty', () => {
        render(<AiReviewScopePicker onPick={() => {}} />);
        expect(screen.queryByText(/Workspace fan-out/)).toBeNull();
        expect(screen.queryByText(/^Repo:/)).toBeNull();
    });

    it('defaults to scope=all', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} />);
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'all' });
    });

    it('respects initialScope override', () => {
        const onPick = vi.fn();
        render(
            <AiReviewScopePicker
                onPick={onPick}
                initialScope={{ kind: 'changed' }}
            />,
        );
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'changed' });
    });

    it('clicking "Changed only" then Start emits changed scope', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} />);
        fireEvent.click(screen.getByText('Changed only'));
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'changed' });
    });

    it('clicking "Selected entry point" then Start emits entry scope', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} />);
        fireEvent.click(screen.getByText('Selected entry point'));
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'entry' });
    });

    it('Cancel button fires onCancel without emitting onPick', () => {
        const onPick = vi.fn();
        const onCancel = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} onCancel={onCancel} />);
        fireEvent.click(screen.getByLabelText('Cancel review'));
        expect(onCancel).toHaveBeenCalled();
        expect(onPick).not.toHaveBeenCalled();
    });
});

describe('AiReviewScopePicker — multi-repo workspace', () => {
    const repos = [
        { repoId: 'auth-svc', name: 'auth-svc', hasChanges: true },
        { repoId: 'profile-svc', name: 'profile-svc', hasChanges: false },
    ];

    it('renders workspace fan-out option when repos provided', () => {
        render(<AiReviewScopePicker onPick={() => {}} repos={repos} />);
        expect(screen.getByText(/Workspace fan-out/)).toBeTruthy();
        expect(screen.getByText(/2 repos/)).toBeTruthy();
    });

    it('renders one option per repo', () => {
        render(<AiReviewScopePicker onPick={() => {}} repos={repos} />);
        // The `~` marker reflects hasChanges:true on auth-svc.
        expect(screen.getByText('Repo: auth-svc ~')).toBeTruthy();
        expect(screen.getByText('Repo: profile-svc')).toBeTruthy();
    });

    it('picking a repo + Start emits {kind: "repo", repoId}', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} repos={repos} />);
        fireEvent.click(screen.getByText('Repo: profile-svc'));
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'repo', repoId: 'profile-svc' });
    });

    it('picking workspace + Start emits {kind: "workspace"}', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} repos={repos} />);
        fireEvent.click(screen.getByText(/Workspace fan-out/));
        fireEvent.click(screen.getByLabelText('Start review'));
        const captured: PickedScope = onPick.mock.calls[0][0];
        expect(captured).toEqual({ kind: 'workspace' });
    });

    it('flat options still work alongside workspace options', () => {
        const onPick = vi.fn();
        render(<AiReviewScopePicker onPick={onPick} repos={repos} />);
        fireEvent.click(screen.getByText('All entry points'));
        fireEvent.click(screen.getByLabelText('Start review'));
        expect(onPick).toHaveBeenCalledWith({ kind: 'all' });
    });
});
