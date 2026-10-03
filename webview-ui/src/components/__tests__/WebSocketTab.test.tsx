/**
 * WebSocketTab.test.tsx — #745 WebSocket client tab (2026-06-06).
 *
 * TDD-first coverage. Component drives a single round-trip: user types
 * URL + outbound frames, clicks Connect, sees captured inbound frames +
 * end reason + close code.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WebSocketTab, { type WebSocketTabState } from '../WebSocketTab';

describe('WebSocketTab — form + connect', () => {
    it('renders URL input + Connect button', () => {
        render(<WebSocketTab onConnect={() => { /* noop */ }} />);
        expect(screen.getByLabelText('WebSocket URL')).toBeTruthy();
        expect(screen.getByTestId('ca-ws-connect-btn')).toBeTruthy();
    });

    it('Connect is disabled until a URL is entered', () => {
        render(<WebSocketTab onConnect={() => { /* noop */ }} />);
        const btn = screen.getByTestId('ca-ws-connect-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('WebSocket URL'), { target: { value: 'ws://localhost:7000' } });
        expect(btn.disabled).toBe(false);
    });

    it('clicking Connect invokes onConnect with URL + parsed frames + maxMessages', () => {
        const spy = vi.fn();
        render(<WebSocketTab onConnect={spy} />);
        fireEvent.change(screen.getByLabelText('WebSocket URL'), { target: { value: 'wss://echo.example.com' } });
        fireEvent.change(screen.getByLabelText('Outbound frames (one per line)'), { target: { value: 'ping\n{"op":"subscribe"}' } });
        fireEvent.change(screen.getByLabelText('Max inbound messages'), { target: { value: '5' } });
        fireEvent.click(screen.getByTestId('ca-ws-connect-btn'));
        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0][0];
        expect(args).toMatchObject({
            url: 'wss://echo.example.com',
            sendMessages: [{ payload: 'ping' }, { payload: '{"op":"subscribe"}' }],
            maxMessages: 5,
        });
        expect(typeof args.requestId).toBe('string');
    });

    it('blank lines in the frames editor are dropped', () => {
        const spy = vi.fn();
        render(<WebSocketTab onConnect={spy} />);
        fireEvent.change(screen.getByLabelText('WebSocket URL'), { target: { value: 'ws://localhost:7000' } });
        fireEvent.change(screen.getByLabelText('Outbound frames (one per line)'), { target: { value: 'one\n\ntwo\n   \nthree' } });
        fireEvent.click(screen.getByTestId('ca-ws-connect-btn'));
        const args = spy.mock.calls[0][0];
        expect(args.sendMessages.map((m: any) => m.payload)).toEqual(['one', 'two', 'three']);
    });
});

describe('WebSocketTab — connection result', () => {
    it('renders captured inbound frames + end reason when status=ready', () => {
        const state: WebSocketTabState = {
            status: 'ready',
            requestId: 'ws-1',
            result: {
                handshakeStatus: 101,
                messages: [
                    { kind: 'text', payload: 'pong', elapsedMs: 12 },
                    { kind: 'text', payload: '{"event":"ack"}', elapsedMs: 45 },
                ],
                closeCode: 1000,
                closeReason: '',
                endReason: 'closed',
                durationMs: 500,
            },
        };
        render(<WebSocketTab state={state} onConnect={() => { /* noop */ }} />);
        const result = screen.getByTestId('ca-ws-result');
        expect(result.textContent ?? '').toMatch(/2 message/);
        expect(result.textContent ?? '').toMatch(/pong/);
        expect(result.textContent ?? '').toMatch(/event.*ack/);
        expect(result.textContent ?? '').toMatch(/closed/);
        expect(result.textContent ?? '').toMatch(/1000/);
    });

    it('shows Connecting label while in-flight', () => {
        const state: WebSocketTabState = { status: 'loading', requestId: 'ws-1' };
        render(<WebSocketTab state={state} onConnect={() => { /* noop */ }} />);
        const btn = screen.getByTestId('ca-ws-connect-btn') as HTMLButtonElement;
        expect(btn.textContent ?? '').toMatch(/Connecting/);
        expect(btn.disabled).toBe(true);
    });

    it('renders error pill on failure', () => {
        const state: WebSocketTabState = { status: 'error', requestId: 'ws-1', error: 'ECONNREFUSED' };
        render(<WebSocketTab state={state} onConnect={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-ws-error').textContent).toMatch(/ECONNREFUSED/);
    });

    it('renders 0 messages summary when result has empty messages array', () => {
        const state: WebSocketTabState = {
            status: 'ready',
            requestId: 'ws-1',
            result: { messages: [], endReason: 'timeout', durationMs: 30000 },
        };
        render(<WebSocketTab state={state} onConnect={() => { /* noop */ }} />);
        const result = screen.getByTestId('ca-ws-result');
        expect(result.textContent ?? '').toMatch(/0 message/);
        expect(result.textContent ?? '').toMatch(/timeout/);
    });
});
