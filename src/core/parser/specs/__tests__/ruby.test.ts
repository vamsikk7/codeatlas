/**
 * specs/__tests__/ruby.test.ts — Unit tests for RUBY_SPEC.
 *
 * Ruby's tree-sitter grammar surfaces `require` as a generic `call`
 * node — the spec's `importTypes: ['call']` over-matches and the
 * `getImports` regex filters down to `require` / `require_relative`.
 */

import { describe, it, expect } from 'vitest';
import { RUBY_SPEC } from '../ruby';
import { mockNode, withField } from './_mock';

describe('RUBY_SPEC', () => {
    it('extracts require statement', () => {
        const src = "require 'sinatra'";
        const node = mockNode({
            type: 'call',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = RUBY_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'sinatra', source: 'sinatra' }]);
    });

    it('extracts require_relative with path', () => {
        const src = "require_relative './lib/foo'";
        const node = mockNode({
            type: 'call',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = RUBY_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'foo', source: './lib/foo' }]);
    });

    it('ignores non-require calls', () => {
        const src = "puts 'hello'";
        const node = mockNode({
            type: 'call',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = RUBY_SPEC.getImports(node, src);
        expect(imports).toEqual([]);
    });

    it('builds function signature with parameters', () => {
        const src = 'def foo(a, b); end';
        const fn = mockNode({
            type: 'method',
            text: src,
            children: [
                withField('name', { type: 'identifier', text: 'foo' }),
                withField('parameters', { type: 'method_parameters', text: 'a, b', startIndex: 8, endIndex: 12 }),
            ],
        });
        const sig = RUBY_SPEC.getFunctionSignature(fn, src);
        expect(sig).toBe('def foo(a, b)');
    });
});
