/**
 * TourView.test.tsx — Issue #702 / #736 tests.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TourView, { type TourStepLite } from '../TourView';

function step(num: number, label: string, overrides: Partial<TourStepLite> = {}): TourStepLite {
    return {
        stepNumber: num,
        entryPointId: `ep-${num}`,
        label,
        why: `Why step ${num} matters.`,
        filePath: `src/file-${num}.ts`,
        symbol: `handler${num}`,
        fanIn: num,
        drillDownGraphId: `sequence:src/file-${num}.ts:handler${num}`,
        ...overrides,
    };
}

describe('TourView', () => {
    it('renders the empty state when no steps are supplied', () => {
        render(<TourView postMessage={() => {}} steps={[]} mode="codebase" />);
        expect(screen.getByText(/No tour steps yet/i)).toBeTruthy();
    });

    it('renders the first step on mount', () => {
        const steps = [step(1, 'GET /first'), step(2, 'GET /second')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.getByText('GET /first')).toBeTruthy();
        expect(screen.getByText('Why step 1 matters.')).toBeTruthy();
    });

    it('Next button advances to step 2', () => {
        const steps = [step(1, 'GET /first'), step(2, 'GET /second')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        const nextBtn = screen.getByRole('button', { name: /Next step/i });
        fireEvent.click(nextBtn);
        expect(screen.getByText('GET /second')).toBeTruthy();
    });

    it('Prev button rewinds to step 1', () => {
        const steps = [step(1, 'A'), step(2, 'B'), step(3, 'C')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        const nextBtn = screen.getByRole('button', { name: /Next step/i });
        fireEvent.click(nextBtn);
        fireEvent.click(nextBtn);
        expect(screen.getByText('C')).toBeTruthy();
        const prevBtn = screen.getByRole('button', { name: /Previous step/i });
        fireEvent.click(prevBtn);
        fireEvent.click(prevBtn);
        expect(screen.getByText('A')).toBeTruthy();
    });

    it('Open diagram button dispatches requestRoute with the step\'s drillDownGraphId', () => {
        const postMessage = vi.fn();
        const steps = [step(1, 'GET /foo', { drillDownGraphId: 'sequence:src/foo.ts:fooHandler' })];
        render(<TourView postMessage={postMessage} steps={steps} mode="codebase" />);
        fireEvent.click(screen.getByText('Open diagram'));
        expect(postMessage).toHaveBeenCalledWith({
            type: 'requestRoute',
            graphId: 'sequence:src/foo.ts:fooHandler',
        });
    });

    it('mode switch button posts a requestTour with the opposite mode', () => {
        const postMessage = vi.fn();
        render(<TourView postMessage={postMessage} steps={[step(1, 'X')]} mode="codebase" />);
        const swapBtn = screen.getByText(/→ Recent changes/);
        fireEvent.click(swapBtn);
        expect(postMessage).toHaveBeenCalledWith({ type: 'requestTour', mode: 'recent' });
    });

    it('jump dropdown navigates to the chosen step', () => {
        const steps = [step(1, 'First'), step(2, 'Second'), step(3, 'Third')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        const select = screen.getByLabelText(/Jump to step/i) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: '3' } });
        expect(screen.getByText('Third')).toBeTruthy();
    });

    it('renders the diff badge for added/modified steps', () => {
        const steps = [
            step(1, 'New route', { diff: 'added' }),
            step(2, 'Old route', { diff: 'modified' }),
        ];
        render(<TourView postMessage={() => {}} steps={steps} mode="recent" />);
        expect(screen.getByText('added')).toBeTruthy();
    });

    it('renders the fan-in badge when fanIn > 0', () => {
        const steps = [step(1, 'Hub', { fanIn: 7 })];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.getByText(/← 7/)).toBeTruthy();
    });
});

// ADR-034 Phase H Pass 3 (#793) — workspace meta-tour shape.
describe('TourView — workspace meta-tour', () => {
    const metaStep = (n: number, repoId: string, label: string): TourStepLite => ({
        stepNumber: n,
        entryPointId: `${repoId}:ep`,
        label,
        why: `Drill into ${repoId} to learn how it fits in.`,
        filePath: `${repoId}/src/main.ts`,
        symbol: 'main',
        fanIn: 0,
        drillDownGraphId: `tour:${repoId}`,
    });

    it('shows the workspace badge + overview copy when every step targets a tour:<repo>', () => {
        const steps = [
            metaStep(1, 'auth-svc', 'auth-svc: POST /login'),
            metaStep(2, 'profile-svc', 'profile-svc: GET /me'),
        ];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.getByText('Workspace')).toBeTruthy();
        expect(screen.getByText('Workspace overview')).toBeTruthy();
    });

    it('hides the mode toggle in meta-tour mode (no recent variant)', () => {
        const steps = [metaStep(1, 'r1', 'r1: GET /'), metaStep(2, 'r2', 'r2: GET /')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.queryByText(/→ Recent changes/)).toBeNull();
        expect(screen.queryByText(/→ Codebase/)).toBeNull();
    });

    it('renders a "Drill into repo tour" primary button instead of Play/Open diagram', () => {
        const steps = [metaStep(1, 'auth-svc', 'auth-svc: POST /login')];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.getByText(/Drill into repo tour/i)).toBeTruthy();
        expect(screen.queryByText(/Play diagram/i)).toBeNull();
    });

    it('Drill-into-repo button posts requestRoute with tour:<repoId>', () => {
        const postMessage = vi.fn();
        const steps = [metaStep(1, 'profile-svc', 'profile-svc: GET /me')];
        render(<TourView postMessage={postMessage} steps={steps} mode="codebase" />);
        fireEvent.click(screen.getByText(/Drill into repo tour/i));
        expect(postMessage).toHaveBeenCalledWith({
            type: 'requestRoute',
            graphId: 'tour:profile-svc',
        });
    });

    it('a single sequence-targeted step falls back to the regular tour UI (not meta)', () => {
        const steps = [{
            stepNumber: 1,
            entryPointId: 'ep',
            label: 'POST /login',
            why: 'Authentication entry point.',
            filePath: 'src/auth.ts',
            symbol: 'login',
            fanIn: 3,
            drillDownGraphId: 'sequence:src/auth.ts:login',
        } as TourStepLite];
        render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(screen.queryByText('Workspace overview')).toBeNull();
        expect(screen.getByText(/Play diagram/i)).toBeTruthy();
    });
});

// Bug D (2026-06-04) — Tour step card footer must NOT render the
// parser's synthetic `anonymous@<METHOD>:<route>` handler symbols.
// Server-side blurb fix lives in tourBuilder; this test pins the
// renderer-side guard so a future builder change can't reintroduce
// the leak.
describe('TourView — Bug D: anonymous handler symbols are hidden', () => {
    it('does NOT render `:: anonymous@GET:/` in the path footer', () => {
        const steps = [step(1, 'GET /', { filePath: 'src/main.ts', symbol: 'anonymous@GET:/' })];
        const { container } = render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        const text = container.textContent ?? '';
        expect(text).not.toMatch(/anonymous@/);
        // The file path should still render — only the synthetic symbol is suppressed.
        expect(text).toMatch(/src\/main\.ts/);
        // And we should NOT see the ` :: ` separator since the symbol is hidden.
        expect(text).not.toMatch(/main\.ts\s*::\s*anonymous/);
    });

    it('still renders the path :: symbol pair for genuinely named handlers', () => {
        const steps = [step(1, 'GET /health', { filePath: 'src/h.ts', symbol: 'healthCheck' })];
        const { container } = render(<TourView postMessage={() => {}} steps={steps} mode="codebase" />);
        expect(container.textContent).toMatch(/src\/h\.ts\s*::\s*healthCheck/);
    });
});
