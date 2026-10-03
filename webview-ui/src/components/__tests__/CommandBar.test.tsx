/**
 * CommandBar.test.tsx — UX-14 (2026-06-04)
 *
 * Toolbar buttons should show a short visible label next to the emoji
 * icon so new users don't see a wall of emojis they have to hover over.
 * Long-form description stays in `title` + `aria-label`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommandBar from '../CommandBar';

beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn() };
});

describe('CommandBar — UX-14: visible short labels', () => {
    it('renders a short visible label next to the System Design icon', () => {
        render(<CommandBar activeMode="microservice" />);
        // Long title/aria stays as-is for accessibility, but the visible
        // button text now also includes a short word so users don't have
        // to hover. We assert the visible label by querying within
        // role="toolbar" → button → text content.
        const btn = screen.getByRole('button', { name: /System Design/i });
        // Visible text includes the icon AND a short label (not just emoji).
        const visibleText = (btn.textContent ?? '').trim();
        expect(visibleText.length).toBeGreaterThan(2); // more than just the emoji
        expect(visibleText).toMatch(/[A-Za-z]/); // contains letters
    });

    it('renders a short label for Feature Areas, APIs, Health', () => {
        render(<CommandBar activeMode="microservice" />);
        const featuresBtn = screen.getByRole('button', { name: /Feature Areas/i });
        const apisBtn = screen.getByRole('button', { name: /API List/i });
        const healthBtn = screen.getByRole('button', { name: /Health Report/i });
        for (const btn of [featuresBtn, apisBtn, healthBtn]) {
            const visible = (btn.textContent ?? '').trim();
            expect(visible).toMatch(/[A-Za-z]/);
        }
    });

    it('L2b button adapts to service category: backend "APIs" vs frontend/mobile "Entry Points"', () => {
        // Default / backend → "APIs" / "API List"
        const { unmount } = render(<CommandBar activeMode="microservice" currentCategory="backend" />);
        expect(screen.getByRole('button', { name: /API List/i })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Entry Points$/i })).toBeNull();
        unmount();

        // Frontend → "Entry Points"
        render(<CommandBar activeMode="microservice" currentCategory="frontend" />);
        expect(screen.getByRole('button', { name: /Entry Points/i })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /API List/i })).toBeNull();
    });

    it('mobile category also yields "Entry Points"', () => {
        render(<CommandBar activeMode="microservice" currentCategory="mobile" />);
        expect(screen.getByRole('button', { name: /Entry Points/i })).toBeTruthy();
    });

    it('keeps aria-label fully descriptive (does not get truncated to the short label)', () => {
        render(<CommandBar activeMode="microservice" />);
        // Overlays: visible short label is "Overlays" but the aria-label/title
        // carry the full description.
        const overlays = screen.getByRole('button', { name: /Overlays/i });
        expect(overlays.getAttribute('aria-label')).toMatch(/choose what gets painted/i);
    });

    it('every non-separator button shows a visible non-emoji-only label', () => {
        const { container } = render(<CommandBar activeMode="microservice" />);
        const buttons = container.querySelectorAll('button.ca-command-bar-btn');
        expect(buttons.length).toBeGreaterThan(6);
        for (const btn of buttons) {
            const text = (btn.textContent ?? '').trim();
            // Each visible button text must include at least one letter
            // (i.e. a word label, not just the emoji icon).
            expect(text).toMatch(/[A-Za-z]/);
        }
    });
});

describe('CommandBar — BUG-EXP-8: hide daemon-unavailable items in standalone mode', () => {
    it('hides Timeline Replay + PR Diff when isStandalone (both always refuse in the MCP daemon)', () => {
        render(<CommandBar activeMode="microservice" isStandalone />);
        expect(screen.queryByRole('button', { name: /Timeline Replay/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /PR Diff/i })).toBeNull();
        // Items that work (or conditionally work) in the daemon stay visible.
        expect(screen.getByRole('button', { name: /Compare Commits/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Impact Analysis/i })).toBeTruthy();
    });

    it('shows Timeline Replay + PR Diff in VS Code mode (not standalone)', () => {
        render(<CommandBar activeMode="microservice" />);
        expect(screen.getByRole('button', { name: /Timeline Replay/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /PR Diff/i })).toBeTruthy();
    });
});
