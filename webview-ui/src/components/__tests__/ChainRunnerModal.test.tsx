/**
 * ChainRunnerModal.test.tsx — Issue #603 Phase 3 chain runner UI tests.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import ChainRunnerModal, { type ChainRunResult } from '../ChainRunnerModal';
import type { ApiTestingEndpoint } from '../ApiTestingView';

beforeAll(() => {
    if (typeof (window as any).PointerEvent === 'undefined') {
        (window as any).PointerEvent = class extends MouseEvent {};
    }
});
afterEach(() => cleanup());

const EP_LIST: ApiTestingEndpoint[] = [
    { id: 'a1', method: 'POST', route: '/api/users/login', handlerName: 'login', filePath: 'src/auth.ts' },
    { id: 'a2', method: 'GET', route: '/api/user', handlerName: 'me', filePath: 'src/auth.ts' },
    { id: 'a3', method: 'POST', route: '/api/articles', handlerName: 'create', filePath: 'src/articles.ts' },
];

const ENV_TEXT = 'base=http://localhost:3000';

const PASSING_RESULT: ChainRunResult = {
    steps: [
        {
            id: 'step:a1:0', label: 'POST /api/users/login', method: 'POST',
            url: 'http://localhost:3000/api/users/login',
            resolvedUrl: 'http://localhost:3000/api/users/login',
            response: { durationMs: 25, status: 200, statusText: 'OK', body: '{"token":"abc"}' },
            extracted: { token: 'abc' },
            assertFailures: [],
            outcome: 'passed',
        },
        {
            id: 'step:a2:1', label: 'GET /api/user', method: 'GET',
            url: 'http://localhost:3000/api/user',
            resolvedUrl: 'http://localhost:3000/api/user',
            response: { durationMs: 18, status: 200, statusText: 'OK', body: '{"username":"x"}' },
            extracted: {},
            assertFailures: [],
            outcome: 'passed',
        },
    ],
    finalEnv: { base: 'http://localhost:3000', token: 'abc' },
    passed: 2,
    failed: 0,
    errored: 0,
    aborted: false,
};

describe('ChainRunnerModal', () => {
    it('renders empty state when no steps are added', () => {
        render(<ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={null} onCancel={() => {}} />);
        expect(screen.getByText(/Steps \(0\)/)).toBeTruthy();
        expect(screen.getByText(/No steps yet/)).toBeTruthy();
    });

    it('opens the endpoint picker when "Add step" is clicked', () => {
        render(<ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={null} onCancel={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /Add step/ }));
        // Picker shows each endpoint as an option.
        expect(screen.getAllByRole('option').length).toBe(EP_LIST.length);
    });

    it('adds a step when an endpoint is picked', () => {
        const { container } = render(
            <ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={null} onCancel={() => {}} />,
        );
        fireEvent.click(screen.getByRole('button', { name: /Add step/ }));
        const firstOption = screen.getAllByRole('option')[0];
        fireEvent.click(firstOption);
        const steps = container.querySelectorAll('.ca-chain-step');
        expect(steps.length).toBe(1);
        expect(screen.getByText(/Steps \(1\)/)).toBeTruthy();
    });

    it('posts a runChain message with steps + env when Run is clicked', () => {
        const postMessage = vi.fn();
        render(
            <ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={postMessage} result={null} onCancel={() => {}} />,
        );
        fireEvent.click(screen.getByRole('button', { name: /Add step/ }));
        fireEvent.click(screen.getAllByRole('option')[0]); // POST /api/users/login
        fireEvent.click(screen.getByRole('button', { name: /Run chain/ }));
        expect(postMessage).toHaveBeenCalledTimes(1);
        const msg = postMessage.mock.calls[0][0] as any;
        expect(msg.type).toBe('runChain');
        expect(msg.steps).toHaveLength(1);
        expect(msg.steps[0].url).toBe('http://localhost:3000/api/users/login');
        expect(msg.initialEnv).toEqual({ base: 'http://localhost:3000' });
        expect(msg.stopOnFirstFailure).toBe(false);
    });

    it('renders per-step result rows with status + outcome class', () => {
        const { container } = render(
            <ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={PASSING_RESULT} onCancel={() => {}} />,
        );
        const rows = container.querySelectorAll('.ca-chain-result-row');
        expect(rows.length).toBe(2);
        expect(rows[0].className).toContain('outcome-passed');
        expect(within(rows[0] as HTMLElement).getByText(/200/)).toBeTruthy();
        expect(screen.getByText(/2 pass/)).toBeTruthy();
    });

    it('shows the final env in a collapsed details when present', () => {
        render(
            <ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={PASSING_RESULT} onCancel={() => {}} />,
        );
        const summary = screen.getByText(/Final env/);
        expect(summary).toBeTruthy();
    });

    it('invokes onCancel when the close button is clicked', () => {
        const onCancel = vi.fn();
        render(
            <ChainRunnerModal available={EP_LIST} envText={ENV_TEXT} postMessage={() => {}} result={null} onCancel={onCancel} />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onCancel).toHaveBeenCalled();
    });
});
