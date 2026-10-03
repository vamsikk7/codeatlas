/**
 * specs/__tests__/dart.test.ts — Unit tests for DART_SPEC.
 *
 * Dart's `import_or_export` wrapper nests the actual import inside
 * `library_import → import_specification → uri`. We also exercise the
 * class-hierarchy extractor: extends + implements + mixin
 * (`class Foo with M1, M2`) all flow into the result, with mixins
 * joining `implementsInterfaces` since we don't track them separately.
 */

import { describe, it, expect } from 'vitest';
import { DART_SPEC } from '../dart';
import { mockNode } from './_mock';

describe('DART_SPEC', () => {
    it('extracts package import and strips `package:` prefix', () => {
        const src = "import 'package:flutter/material.dart';";
        const node = mockNode({
            type: 'import_or_export',
            text: src,
            children: [
                { type: 'library_import', text: src, children: [
                    { type: 'import_specification', text: src, children: [
                        { type: 'uri', text: "'package:flutter/material.dart'", startIndex: 7, endIndex: 38 },
                    ] },
                ] },
            ],
        });
        const imports = DART_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'material', source: 'flutter/material.dart' }]);
    });

    it('getClassHierarchy: extends + implements + mixin all surface', () => {
        const classNode = mockNode({
            type: 'class_definition',
            text: 'class Foo extends Bar with Mixin1, Mixin2 implements IBaz {}',
            children: [
                { type: 'superclass', text: 'extends Bar', children: [
                    { type: 'type_identifier', text: 'Bar' },
                ] },
                { type: 'interfaces', text: 'implements IBaz', children: [
                    { type: 'type_identifier', text: 'IBaz' },
                ] },
                { type: 'mixins', text: 'with Mixin1, Mixin2', children: [
                    { type: 'type_identifier', text: 'Mixin1' },
                    { type: 'type_identifier', text: 'Mixin2' },
                ] },
            ],
        });
        const result = DART_SPEC.getClassHierarchy!(classNode, 'class Foo extends Bar with Mixin1, Mixin2 implements IBaz {}');
        expect(result.extendsClass).toBe('Bar');
        // Mixins join implementsInterfaces — no separate field.
        expect(result.implementsInterfaces).toEqual(expect.arrayContaining(['IBaz', 'Mixin1', 'Mixin2']));
    });

    it('classTypes contains class_definition (Dart-specific)', () => {
        expect(DART_SPEC.classTypes).toEqual(['class_definition']);
    });

    it('importTypes uses import_or_export wrapper', () => {
        expect(DART_SPEC.importTypes).toEqual(['import_or_export']);
    });
});
