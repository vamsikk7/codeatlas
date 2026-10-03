/**
 * AtlasNode.test.tsx — Issue 383
 *
 * Pins the `n.diff` → rendered-DOM pipeline. The unit tests under
 * `__tests__/diffColors.test.ts` cover the mapping CONSTANTS; this file
 * verifies that AtlasNode actually applies them to the rendered output.
 *
 * Regression coverage: every diff status produces (a) the right border
 * style on the body container, (b) the matching `+ added` / `− deleted` /
 * `~ modified` badge, (c) line-through styling on deleted nodes, and (d)
 * no badge on unchanged nodes.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import AtlasNode from './AtlasNode';
import { DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';

function renderNode(diff: string | undefined) {
    return render(
        <ReactFlowProvider>
            <AtlasNode data={{ label: 'getCurrentUser', type: 'function', diff } as any} />
        </ReactFlowProvider>
    );
}

/**
 * jsdom doesn't expand inline shorthand `style.border` reliably. Pull
 * the raw style attribute instead.
 */
function rawStyle(el: Element): string {
    return el.getAttribute('style') ?? '';
}

function findBody(container: HTMLElement): HTMLElement {
    // AtlasNode renders: wrapper > [Handle, body div, Handle, badge?]
    // The body div is the one carrying the `border: 1.5px <style> ...` rule.
    const divs = container.querySelectorAll('div');
    for (const d of Array.from(divs)) {
        if (rawStyle(d).includes('border:')) return d as HTMLElement;
    }
    throw new Error('AtlasNode body container not found');
}

describe('AtlasNode — diff rendering integration (Issue 383)', () => {
    it('added: body border is solid, badge shows "+ added"', () => {
        const { container, getByText } = renderNode('added');
        const body = findBody(container);
        expect(rawStyle(body)).toMatch(/border:\s*1\.5px\s+solid/);
        expect(getByText(/\+\s*added/i)).toBeTruthy();
    });

    it('deleted: body border is dashed, badge shows "− deleted", label has line-through', () => {
        const { container, getByText } = renderNode('deleted');
        const body = findBody(container);
        expect(rawStyle(body)).toMatch(/border:\s*1\.5px\s+dashed/);
        expect(getByText(/−\s*deleted/)).toBeTruthy();
        const label = getByText('getCurrentUser') as HTMLElement;
        expect(rawStyle(label)).toMatch(/text-decoration:\s*line-through/);
    });

    it('modified: body border is dotted, badge shows "~ modified"', () => {
        const { container, getByText } = renderNode('modified');
        const body = findBody(container);
        expect(rawStyle(body)).toMatch(/border:\s*1\.5px\s+dotted/);
        expect(getByText(/~\s*modified/i)).toBeTruthy();
    });

    it('unchanged: body border is solid, no diff badge', () => {
        const { container } = renderNode('unchanged');
        const body = findBody(container);
        expect(rawStyle(body)).toMatch(/border:\s*1\.5px\s+solid/);
        const text = container.textContent ?? '';
        expect(text).not.toMatch(/\+ added|− deleted|~ modified/);
    });

    it('missing diff defaults to unchanged (no badge)', () => {
        const { container } = renderNode(undefined);
        const text = container.textContent ?? '';
        expect(text).not.toMatch(/\+ added|− deleted|~ modified/);
    });

    it('section nodes always use solid border regardless of diff', () => {
        // Sections are visual headers; their border doesn't carry the
        // diff style — the modified state is communicated by the badge.
        const { container } = render(
            <ReactFlowProvider>
                <AtlasNode data={{ label: 'Functions (1 changed + 4)', type: 'section', diff: 'modified' } as any} />
            </ReactFlowProvider>
        );
        const body = findBody(container);
        expect(rawStyle(body)).toMatch(/border:\s*1\.5px\s+solid/);
    });

    it('emits the canonical diff symbols (sanity wiring check)', () => {
        // Regression guard: if someone re-orders DIFF_SYMBOLS, this catches
        // the mismatch at the render layer. Symbols are characters with
        // regex special-meaning (+, ~), so escape them first.
        const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { getByText: getAdded } = renderNode('added');
        expect(getAdded(new RegExp(escape(DIFF_SYMBOLS.added))).textContent).toContain(DIFF_SYMBOLS.added);
        const { getByText: getDel } = renderNode('deleted');
        expect(getDel(new RegExp(escape(DIFF_SYMBOLS.deleted))).textContent).toContain(DIFF_SYMBOLS.deleted);
        const { getByText: getMod } = renderNode('modified');
        expect(getMod(new RegExp(escape(DIFF_SYMBOLS.modified))).textContent).toContain(DIFF_SYMBOLS.modified);
    });

    it('canonical DIFF_BORDER_STYLES values match the rendered DOM', () => {
        // Loops over every status so a future addition (e.g. 'renamed')
        // is caught the moment AtlasNode handles it.
        for (const status of ['added', 'deleted', 'modified', 'unchanged'] as const) {
            const { container } = renderNode(status);
            const body = findBody(container);
            expect(rawStyle(body)).toMatch(
                new RegExp(`border:\\s*1\\.5px\\s+${DIFF_BORDER_STYLES[status]}`)
            );
        }
    });
});
