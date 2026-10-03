/**
 * specs/__tests__/javascript.test.ts — Unit tests for JAVASCRIPT_SPEC.
 *
 * Focused on the accessors that differ from the dispatcher-level
 * coverage in `treeSitterExtractor.test.ts`: import-shape variants
 * (default + named + bare module) and signature formatting.
 */

import { describe, it, expect } from 'vitest';
import { JAVASCRIPT_SPEC } from '../javascript';
import { mockNode, withField } from './_mock';

describe('JAVASCRIPT_SPEC', () => {
    it('extracts default import', () => {
        const node = mockNode({
            type: 'import_statement',
            text: 'import React from "react"',
            children: [
                { type: 'identifier', text: 'React' },
                { type: 'string', text: '"react"' },
            ],
        });
        const imports = JAVASCRIPT_SPEC.getImports(node, 'import React from "react"');
        expect(imports).toContainEqual({ local: 'React', source: 'react' });
    });

    it('extracts named imports', () => {
        const node = mockNode({
            type: 'import_statement',
            text: 'import { useState, useEffect } from "react"',
            children: [
                { type: 'import_clause', text: '{ useState, useEffect }', children: [
                    { type: 'named_imports', text: '{ useState, useEffect }', children: [
                        { type: 'import_specifier', text: 'useState', children: [
                            { type: 'identifier', text: 'useState' },
                        ] },
                        { type: 'import_specifier', text: 'useEffect', children: [
                            { type: 'identifier', text: 'useEffect' },
                        ] },
                    ] },
                ] },
                { type: 'string', text: '"react"' },
            ],
        });
        const imports = JAVASCRIPT_SPEC.getImports(node, 'import { useState, useEffect } from "react"');
        expect(imports.map(i => i.local)).toEqual(expect.arrayContaining(['useState', 'useEffect']));
        expect(imports.every(i => i.source === 'react')).toBe(true);
    });

    it('falls back to module path when no named/default import found', () => {
        const node = mockNode({
            type: 'import_statement',
            text: 'import "./styles.css"',
            children: [
                { type: 'string', text: '"./styles.css"' },
            ],
        });
        const imports = JAVASCRIPT_SPEC.getImports(node, 'import "./styles.css"');
        expect(imports).toEqual([{ local: './styles.css', source: './styles.css' }]);
    });

    it('builds function signature with parameters', () => {
        const src = 'function add(a, b) { return a + b; }';
        const node = mockNode({
            type: 'function_declaration',
            text: src,
            children: [
                withField('name', { type: 'identifier', text: 'add' }),
                withField('parameters', { type: 'formal_parameters', text: '(a, b)', startIndex: 12, endIndex: 18 }),
            ],
        });
        const sig = JAVASCRIPT_SPEC.getFunctionSignature(node, src);
        expect(sig).toBe('add(a, b)');
    });

    it('falls back to anonymous when function has no name', () => {
        const src = '() => 1';
        const node = mockNode({
            type: 'arrow_function',
            text: src,
            children: [
                withField('parameters', { type: 'formal_parameters', text: '()', startIndex: 0, endIndex: 2 }),
            ],
        });
        const sig = JAVASCRIPT_SPEC.getFunctionSignature(node, src);
        expect(sig).toBe('anonymous()');
    });

    it('extracts variable declarator name', () => {
        const node = mockNode({
            type: 'lexical_declaration',
            text: 'const myVar = 1',
            children: [
                { type: 'variable_declarator', text: 'myVar = 1', children: [
                    withField('name', { type: 'identifier', text: 'myVar' }),
                ] },
            ],
        });
        expect(JAVASCRIPT_SPEC.getVariableName(node)).toBe('myVar');
    });
});
