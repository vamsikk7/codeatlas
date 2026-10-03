/**
 * ForceMeasureNodes — retry-ladder regression (BUG-EXPLORE-3, 2026-07-15)
 *
 * The rAF-only schedule measured the first mount but lost the race on the
 * DiagramView→DiagramView keyed remount (file↔flow nav), so edges vanished
 * after navigation. The fix re-stamps node dimensions on a widening
 * setTimeout ladder that outlasts RF's settle, stopping early once every node
 * carries `handleBounds`. These tests drive the ladder against a fake RF store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

// Mock the RF store hook so the component runs outside a real <ReactFlow>.
let fakeState: any;
vi.mock('reactflow', () => ({
    useStoreApi: () => ({ getState: () => fakeState }),
}));

import { ForceMeasureNodes } from './ForceMeasureNodes';

function makeDom(ids: string[]): HTMLElement {
    const root = document.createElement('div');
    for (const id of ids) {
        const el = document.createElement('div');
        el.className = 'react-flow__node';
        el.setAttribute('data-id', id);
        root.appendChild(el);
    }
    document.body.appendChild(root);
    return root;
}

beforeEach(() => {
    vi.useFakeTimers();
    // rAF → immediate microtask-ish so the fake-timer flush drives it too.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        return window.setTimeout(() => cb(performance.now?.() ?? 0), 0) as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', (h: number) => window.clearTimeout(h));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('ForceMeasureNodes retry ladder', () => {
    it('keeps re-stamping across the setTimeout ladder when nodes stay unmeasured', () => {
        const ids = ['a', 'b'];
        const dom = makeDom(ids);
        const updateNodeDimensions = vi.fn();
        // nodeInternals with NO handleBounds → allMeasured() stays false, so
        // the ladder should run to completion (never early-stop).
        fakeState = {
            domNode: dom,
            updateNodeDimensions,
            nodeInternals: new Map(ids.map((id) => [id, { width: 200, height: 60 }])),
        };
        render(<ForceMeasureNodes nodeIds={ids} />);
        // Immediate pass fired synchronously during the effect.
        expect(updateNodeDimensions).toHaveBeenCalledTimes(1);
        // Advance past the whole ladder (600ms) + rAF chain.
        vi.advanceTimersByTime(700);
        // Immediate + 2 rAF + 5 setTimeout ladder rungs = 8 stamps.
        expect(updateNodeDimensions.mock.calls.length).toBeGreaterThanOrEqual(6);
    });

    it('early-stops the ladder once every node has handleBounds', () => {
        const ids = ['a', 'b'];
        const dom = makeDom(ids);
        const updateNodeDimensions = vi.fn(() => {
            // Simulate RF stamping handleBounds on the forced measure.
            for (const id of ids) {
                fakeState.nodeInternals.get(id).handleBounds = { source: [], target: [] };
            }
        });
        fakeState = {
            domNode: dom,
            updateNodeDimensions,
            nodeInternals: new Map(ids.map((id) => [id, { width: 200, height: 60 }])),
        };
        render(<ForceMeasureNodes nodeIds={ids} />);
        // First (immediate) pass stamps handleBounds → allMeasured() true →
        // the rest of the ladder is cancelled.
        expect(updateNodeDimensions).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(700);
        expect(updateNodeDimensions).toHaveBeenCalledTimes(1);
    });

    it('does nothing when there are no nodes', () => {
        const updateNodeDimensions = vi.fn();
        fakeState = { domNode: makeDom([]), updateNodeDimensions, nodeInternals: new Map() };
        render(<ForceMeasureNodes nodeIds={[]} />);
        vi.advanceTimersByTime(700);
        expect(updateNodeDimensions).not.toHaveBeenCalled();
    });
});
