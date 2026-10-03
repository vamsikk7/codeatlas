/**
 * specs/__tests__/go.test.ts — Unit tests for GO_SPEC.
 *
 * Focused on the Issue #489 quirk: method names get prefixed with the
 * receiver type so files declaring `Bind()` on multiple receivers don't
 * collide on a single `flow:<file>:Bind` graph ID.
 */

import { describe, it, expect } from 'vitest';
import { GO_SPEC } from '../go';
import { mockNode, withField } from './_mock';

describe('GO_SPEC', () => {
    it('returns bare name for non-method function_declaration', () => {
        const fn = mockNode({
            type: 'function_declaration',
            text: 'func Bind() {}',
            children: [
                withField('name', { type: 'identifier', text: 'Bind' }),
            ],
        });
        expect(GO_SPEC.getFunctionName(fn)).toBe('Bind');
    });

    it('prefixes method name with receiver type (#489)', () => {
        const method = mockNode({
            type: 'method_declaration',
            text: 'func (u *UserPayload) Bind() {}',
            children: [
                withField('name', { type: 'identifier', text: 'Bind' }),
                withField('receiver', { type: 'parameter_list', text: '(u *UserPayload)', children: [
                    { type: 'parameter_declaration', text: 'u *UserPayload', children: [
                        withField('type', { type: 'pointer_type', text: '*UserPayload', children: [
                            { type: 'type_identifier', text: 'UserPayload' },
                        ] }),
                    ] },
                ] }),
            ],
        });
        expect(GO_SPEC.getFunctionName(method)).toBe('UserPayload.Bind');
    });

    it('handles non-pointer receiver type', () => {
        const method = mockNode({
            type: 'method_declaration',
            text: 'func (u UserPayload) Bind() {}',
            children: [
                withField('name', { type: 'identifier', text: 'Bind' }),
                withField('receiver', { type: 'parameter_list', text: '(u UserPayload)', children: [
                    { type: 'parameter_declaration', text: 'u UserPayload', children: [
                        withField('type', { type: 'type_identifier', text: 'UserPayload' }),
                    ] },
                ] }),
            ],
        });
        expect(GO_SPEC.getFunctionName(method)).toBe('UserPayload.Bind');
    });

    it('extracts single import_spec', () => {
        const src = 'import "fmt"';
        const node = mockNode({
            type: 'import_declaration',
            text: src,
            children: [
                { type: 'interpreted_string_literal', text: '"fmt"' },
            ],
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = GO_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'fmt', source: 'fmt' }]);
    });

    it('extracts grouped imports via descendantsOfType', () => {
        const node = mockNode({
            type: 'import_declaration',
            text: 'import ( "fmt"\n"net/http" )',
            children: [
                { type: 'import_spec', text: '"fmt"', children: [
                    { type: 'interpreted_string_literal', text: '"fmt"' },
                ] },
                { type: 'import_spec', text: '"net/http"', children: [
                    { type: 'interpreted_string_literal', text: '"net/http"' },
                ] },
            ],
        });
        const imports = GO_SPEC.getImports(node, 'import ( "fmt"\n"net/http" )');
        expect(imports.map(i => i.source)).toEqual(['fmt', 'net/http']);
        expect(imports.find(i => i.source === 'net/http')?.local).toBe('http');
    });
});
