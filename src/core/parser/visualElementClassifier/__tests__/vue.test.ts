/**
 * vue.test.ts — Issue #485-VISUAL Vue classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyVueElement, classifyVueSource } from '../vue';

describe('classifyVueElement', () => {
    it('HTML primitives match the React mapping', () => {
        expect(classifyVueElement('button')).toBe('Button');
        expect(classifyVueElement('input')).toBe('Input');
        expect(classifyVueElement('ul')).toBe('List');
        expect(classifyVueElement('img')).toBe('Image');
        expect(classifyVueElement('form')).toBe('Form');
        expect(classifyVueElement('hr')).toBe('Divider');
    });

    it('Vuetify v-* components classify correctly', () => {
        expect(classifyVueElement('v-btn')).toBe('Button');
        expect(classifyVueElement('v-text-field')).toBe('Input');
        expect(classifyVueElement('v-switch')).toBe('Toggle');
        expect(classifyVueElement('v-select')).toBe('Picker');
        expect(classifyVueElement('v-data-table')).toBe('List');
        expect(classifyVueElement('v-dialog')).toBe('Modal');
    });

    it('Element Plus el-* components classify correctly', () => {
        expect(classifyVueElement('el-button')).toBe('Button');
        expect(classifyVueElement('el-input')).toBe('Input');
        expect(classifyVueElement('el-table')).toBe('List');
    });

    it('PascalCase / kebab-case user components → Custom', () => {
        expect(classifyVueElement('LoginForm')).toBe('Custom');
        expect(classifyVueElement('user-card')).toBe('Custom');
    });
});

describe('classifyVueSource — SFC template scan', () => {
    it('scans only inside <template> when present', () => {
        const src = `
            <script setup>
            const noise = '<button>noise</button>';
            </script>

            <template>
                <form>
                    <v-text-field v-model="email" />
                    <v-btn @click="onSubmit">Submit</v-btn>
                </form>
            </template>

            <style>
            .foo { color: red; }
            </style>
        `;
        const out = classifyVueSource(src);
        expect(out.get('Form')).toBe(1);
        expect(out.get('Input')).toBe(1);
        expect(out.get('Button')).toBe(1);
    });

    it('falls back to whole source when no <template> block exists', () => {
        const src = `<div><button>X</button></div>`;
        const out = classifyVueSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Button')).toBe(1);
    });

    it('does not double-count closing tags', () => {
        const src = `<template><div><span>x</span></div></template>`;
        const out = classifyVueSource(src);
        expect(out.get('Layout')).toBe(1);
        expect(out.get('Label')).toBe(1);
    });
});
