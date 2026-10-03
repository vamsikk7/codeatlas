/**
 * ScriptEditor.test.tsx — Issue #603 Phase 3.6.
 *
 * The component graceful-upgrades to Monaco when the optional dep is
 * installed. Tests force the fallback path so they don't have to spin
 * up the Monaco runtime — which is fine because the fallback IS the
 * default experience for everyone who hasn't installed the dep.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ScriptEditor from '../ScriptEditor';

afterEach(() => cleanup());

describe('ScriptEditor — fallback path', () => {
    it('renders a textarea when forceFallback is true', () => {
        render(
            <ScriptEditor value="initial" onChange={() => {}} forceFallback aria-label="Body" />,
        );
        const ta = screen.getByLabelText('Body') as HTMLTextAreaElement;
        expect(ta.tagName).toBe('TEXTAREA');
        expect(ta.value).toBe('initial');
    });

    it('forwards textarea changes via onChange', () => {
        const onChange = vi.fn();
        render(
            <ScriptEditor value="" onChange={onChange} forceFallback aria-label="x" />,
        );
        fireEvent.change(screen.getByLabelText('x'), { target: { value: 'typed' } });
        expect(onChange).toHaveBeenLastCalledWith('typed');
    });

    it('honours the placeholder + height props on the fallback', () => {
        const { container } = render(
            <ScriptEditor
                value=""
                onChange={() => {}}
                forceFallback
                placeholder="hint"
                height="200px"
                aria-label="ed"
            />,
        );
        const ta = screen.getByLabelText('ed') as HTMLTextAreaElement;
        expect(ta.placeholder).toBe('hint');
        // minHeight is set inline.
        expect(container.querySelector('textarea')?.style.minHeight).toBe('200px');
    });
});

// Note: the Monaco-active path is exercised in integration when the
// user installs `@monaco-editor/react` locally. The dynamic-import
// shim returns null when the dep is absent, which is the path our
// vitest environment always hits — testing it explicitly here would
// require either (a) installing Monaco in the test runner (heavy) or
// (b) mocking the dynamic-import factory (the factory is built via
// `new Function(...)` to escape bundler resolution, so it's not
// straightforward to mock). The fallback path is the safety net.
