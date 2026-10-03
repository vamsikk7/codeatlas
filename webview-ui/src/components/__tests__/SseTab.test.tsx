/**
 * SseTab.test.tsx — #745 SSE client tab (2026-06-06).
 *
 * Parallel to WebSocketTab — URL form + connect button + result panel.
 * Backend dispatches to `streamSse` and returns captured events.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SseTab, { type SseTabState } from '../SseTab';

describe('SseTab — form + connect', () => {
    it('renders URL input + Connect button', () => {
        render(<SseTab onConnect={() => { /* noop */ }} />);
        expect(screen.getByLabelText('SSE URL')).toBeTruthy();
        expect(screen.getByTestId('ca-sse-connect-btn')).toBeTruthy();
    });

    it('Connect is disabled until a URL is entered', () => {
        render(<SseTab onConnect={() => { /* noop */ }} />);
        const btn = screen.getByTestId('ca-sse-connect-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('SSE URL'), { target: { value: 'http://localhost:3000/events' } });
        expect(btn.disabled).toBe(false);
    });

    it('clicking Connect invokes onConnect with URL + maxEvents + bearer token', () => {
        const spy = vi.fn();
        render(<SseTab onConnect={spy} />);
        fireEvent.change(screen.getByLabelText('SSE URL'), { target: { value: 'https://api.example.com/stream' } });
        fireEvent.change(screen.getByLabelText('Max events'), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText('Bearer token (optional)'), { target: { value: 'tk-xyz' } });
        fireEvent.click(screen.getByTestId('ca-sse-connect-btn'));
        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0][0];
        expect(args).toMatchObject({
            url: 'https://api.example.com/stream',
            maxEvents: 20,
            bearerToken: 'tk-xyz',
        });
        expect(typeof args.requestId).toBe('string');
    });
});

describe('SseTab — stream result', () => {
    it('renders captured events + end reason when status=ready', () => {
        const state: SseTabState = {
            status: 'ready',
            requestId: 'sse-1',
            result: {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'text/event-stream' },
                events: [
                    { type: 'message', data: 'tick 1', elapsedMs: 100 },
                    { type: 'message', data: 'tick 2', elapsedMs: 200 },
                    { type: 'pong', data: '{"alive":true}', id: 'pong-1', elapsedMs: 300 },
                ],
                endReason: 'max-events',
                durationMs: 350,
            },
        };
        render(<SseTab state={state} onConnect={() => { /* noop */ }} />);
        const result = screen.getByTestId('ca-sse-result');
        expect(result.textContent ?? '').toMatch(/3 event/);
        expect(result.textContent ?? '').toMatch(/tick 1/);
        expect(result.textContent ?? '').toMatch(/pong/);
        expect(result.textContent ?? '').toMatch(/max-events/);
        expect(result.textContent ?? '').toMatch(/200 OK/);
    });

    it('shows Connecting label while in-flight', () => {
        const state: SseTabState = { status: 'loading', requestId: 'sse-1' };
        render(<SseTab state={state} onConnect={() => { /* noop */ }} />);
        const btn = screen.getByTestId('ca-sse-connect-btn') as HTMLButtonElement;
        expect(btn.textContent ?? '').toMatch(/Connecting/);
        expect(btn.disabled).toBe(true);
    });

    it('renders error pill on failure', () => {
        const state: SseTabState = { status: 'error', requestId: 'sse-1', error: 'CORS error' };
        render(<SseTab state={state} onConnect={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-sse-error').textContent).toMatch(/CORS error/);
    });

    it('renders 0 events summary when result has empty events array', () => {
        const state: SseTabState = {
            status: 'ready',
            requestId: 'sse-1',
            result: {
                status: 200,
                statusText: 'OK',
                headers: {},
                events: [],
                endReason: 'timeout',
                durationMs: 30000,
            },
        };
        render(<SseTab state={state} onConnect={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-sse-result').textContent ?? '').toMatch(/0 event/);
    });
});
