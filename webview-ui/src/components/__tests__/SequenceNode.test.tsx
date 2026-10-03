/**
 * SequenceNode.test.tsx — TDD regression for L3-C1 (2026-06-07).
 *
 * The live-verify finding: L3 sequence header shows "1 modified · 1 msg"
 * correctly, but my CSS probe `[class*="participant"]` couldn't find the
 * `~` marker on the modified participant. Reading the source revealed the
 * diff badge IS rendered (SequenceNode.tsx line 198) — just as a sibling
 * of the .ca-seq-participant container, not a child.
 *
 * These tests lock in the contract:
 *   - The badge IS present in the DOM when diff !== 'unchanged'
 *   - The badge text contains the diff symbol (~) + word (modified)
 *   - No badge when diff === 'unchanged'
 *
 * Prevents future "fix" attempts from accidentally removing the badge while
 * trying to address the false-positive measurement.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import SequenceNode from '../SequenceNode';

function renderNode(data: any) {
    return render(
        <ReactFlowProvider>
            <SequenceNode data={data} />
        </ReactFlowProvider>,
    );
}

describe('SequenceNode — L3-C1: per-participant diff marker', () => {
    it('renders ~ modified badge when participant.diff === "modified"', () => {
        const { container } = renderNode({
            label: 'auth.service.ts',
            subtitle: '«module»',
            kind: 'module',
            diff: 'modified',
        });
        const html = container.innerHTML;
        // The DIFF_SYMBOLS map renders "~" for modified.
        expect(html).toContain('~');
        // The badge also contains the literal word.
        expect(html.toLowerCase()).toContain('modified');
    });

    it('renders + added badge when participant.diff === "added"', () => {
        const { container } = renderNode({
            label: 'new.service.ts',
            subtitle: '«module»',
            kind: 'module',
            diff: 'added',
        });
        const html = container.innerHTML;
        expect(html).toContain('+');
        expect(html.toLowerCase()).toContain('added');
    });

    it('renders − deleted badge when participant.diff === "deleted"', () => {
        const { container } = renderNode({
            label: 'gone.service.ts',
            subtitle: '«module»',
            kind: 'module',
            diff: 'deleted',
        });
        const html = container.innerHTML;
        // DIFF_SYMBOLS uses the Unicode minus sign for deleted.
        expect(html.toLowerCase()).toContain('deleted');
    });

    it('shows NO diff badge when participant.diff === "unchanged"', () => {
        const { container } = renderNode({
            label: 'auth.service.ts',
            subtitle: '«module»',
            kind: 'module',
            diff: 'unchanged',
        });
        const html = container.innerHTML.toLowerCase();
        // No "modified"/"added"/"deleted" badge text in the DOM.
        expect(html).not.toContain('modified');
        expect(html).not.toContain('added');
        expect(html).not.toContain('deleted');
    });

    it('renders the participant label and subtitle regardless of diff state', () => {
        const { container } = renderNode({
            label: 'auth.service.ts',
            subtitle: '«module»',
            kind: 'module',
            diff: 'modified',
        });
        const text = container.textContent ?? '';
        expect(text).toContain('auth.service.ts');
        expect(text).toContain('«module»');
    });
});
