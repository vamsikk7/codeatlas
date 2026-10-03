/**
 * specs/__tests__/c.test.ts — Unit tests for C_SPEC (also used for C++).
 *
 * C's `function_definition → declarator` chain is the most fragile
 * accessor — it has to unwrap one level of pointer indirection
 * (`pointer_declarator → function_declarator`) before finding the
 * inner identifier. Covered here in both shapes.
 */

import { describe, it, expect } from 'vitest';
import { C_SPEC } from '../c';
import { mockNode, withField } from './_mock';

describe('C_SPEC', () => {
    it('extracts #include <stdio.h>', () => {
        const node = mockNode({
            type: 'preproc_include',
            text: '#include <stdio.h>',
            children: [
                { type: 'system_lib_string', text: '<stdio.h>' },
            ],
        });
        const imports = C_SPEC.getImports(node, '#include <stdio.h>');
        expect(imports).toEqual([{ local: 'stdio.h', source: 'stdio.h' }]);
    });

    it('extracts #include "myfile.h"', () => {
        const node = mockNode({
            type: 'preproc_include',
            text: '#include "myfile.h"',
            children: [
                { type: 'string_literal', text: '"myfile.h"' },
            ],
        });
        const imports = C_SPEC.getImports(node, '#include "myfile.h"');
        expect(imports).toEqual([{ local: 'myfile.h', source: 'myfile.h' }]);
    });

    it('extracts function name from direct function_declarator', () => {
        const fnNode = mockNode({
            type: 'function_definition',
            text: 'int main(void) {}',
            children: [
                withField('declarator', { type: 'function_declarator', text: 'main(void)', children: [
                    withField('declarator', { type: 'identifier', text: 'main' }),
                ] }),
            ],
        });
        expect(C_SPEC.getFunctionName(fnNode)).toBe('main');
    });

    it('extracts function name from pointer_declarator chain', () => {
        const fnNode = mockNode({
            type: 'function_definition',
            text: 'int *get_buffer(void) {}',
            children: [
                withField('declarator', { type: 'pointer_declarator', text: '*get_buffer(void)', children: [
                    { type: 'function_declarator', text: 'get_buffer(void)', children: [
                        withField('declarator', { type: 'identifier', text: 'get_buffer' }),
                    ] },
                ] }),
            ],
        });
        expect(C_SPEC.getFunctionName(fnNode)).toBe('get_buffer');
    });

    it('struct + enum + union are all classTypes', () => {
        expect(C_SPEC.classTypes).toEqual([
            'struct_specifier', 'enum_specifier', 'union_specifier',
        ]);
    });
});
