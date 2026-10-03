/**
 * svelte.test.ts — Issue #485-VISUAL Svelte classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifySvelteElement, classifySvelteSource } from '../svelte';

describe('classifySvelteElement', () => {
    it('HTML primitives', () => {
        expect(classifySvelteElement('button')).toBe('Button');
        expect(classifySvelteElement('input')).toBe('Input');
        expect(classifySvelteElement('ul')).toBe('List');
        expect(classifySvelteElement('img')).toBe('Image');
    });

    it('svelte:* special elements are ignored', () => {
        expect(classifySvelteElement('svelte:head')).toBeUndefined();
        expect(classifySvelteElement('svelte:component')).toBeUndefined();
    });

    it('PascalCase user component → Custom', () => {
        expect(classifySvelteElement('LoginForm')).toBe('Custom');
    });
});

describe('classifySvelteSource', () => {
    it('strips <script> and <style> before scanning', () => {
        const src = `
            <script>
            const x = '<button>noise</button>';
            </script>

            <form>
                <input type="email" />
                <button>Sign in</button>
            </form>

            <style>
            button { color: red; }
            </style>
        `;
        const out = classifySvelteSource(src);
        expect(out.get('Form')).toBe(1);
        expect(out.get('Input')).toBe(1);
        // Only the markup button counts; the strings in <script>/<style>
        // were stripped.
        expect(out.get('Button')).toBe(1);
    });

    it('tallies PascalCase user components as Custom', () => {
        const src = `<LoginForm /><SignupForm />`;
        const out = classifySvelteSource(src);
        expect(out.get('Custom')).toBe(2);
    });

    it('does not double-count closing tags', () => {
        const src = `<div><span>x</span></div>`;
        const out = classifySvelteSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
    });
});
