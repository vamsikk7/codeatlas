/**
 * specs/__tests__/csharp.test.ts — Unit tests for CSHARP_SPEC.
 *
 * Covers `using` directive parsing (regular + static), and the
 * `getDecorators` accessor that returns whole `attribute_list` blocks
 * (C# packs multiple attributes into one `[..., ...]`).
 */

import { describe, it, expect } from 'vitest';
import { CSHARP_SPEC } from '../csharp';
import { mockNode } from './_mock';

describe('CSHARP_SPEC', () => {
    it('extracts using directive', () => {
        const src = 'using System.Collections.Generic;';
        const node = mockNode({
            type: 'using_directive',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = CSHARP_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'Generic', source: 'System.Collections.Generic' }]);
    });

    it('extracts using static directive', () => {
        const src = 'using static System.Math;';
        const node = mockNode({
            type: 'using_directive',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = CSHARP_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'Math', source: 'System.Math' }]);
    });

    it('getDecorators returns whole attribute_list text', () => {
        const src = '[HttpGet, Route("/api")]';
        const method = mockNode({
            type: 'method_declaration',
            text: 'public IActionResult Get() {}',
            children: [
                { type: 'attribute_list', text: src, startIndex: 0, endIndex: src.length },
            ],
        });
        const decorators = CSHARP_SPEC.getDecorators!(method, src);
        expect(decorators).toEqual([src]);
    });

    it('struct + enum included in classTypes', () => {
        expect(CSHARP_SPEC.classTypes).toContain('struct_declaration');
        expect(CSHARP_SPEC.classTypes).toContain('enum_declaration');
    });
});
