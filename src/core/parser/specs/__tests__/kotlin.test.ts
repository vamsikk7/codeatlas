/**
 * specs/__tests__/kotlin.test.ts — Unit tests for KOTLIN_SPEC.
 *
 * Kotlin's grammar uses `simple_identifier` for almost everything,
 * including class names — the spec's `getClassName` reaches for
 * `type_identifier` first then falls back. We exercise the import
 * regex, the property-name extraction via `simple_identifier`, and the
 * delegation-specifier path through `getClassHierarchy`.
 */

import { describe, it, expect } from 'vitest';
import { KOTLIN_SPEC } from '../kotlin';
import { mockNode } from './_mock';

describe('KOTLIN_SPEC', () => {
    it('extracts import_header', () => {
        const src = 'import com.example.foo.Bar';
        const node = mockNode({
            type: 'import_header',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = KOTLIN_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'Bar', source: 'com.example.foo.Bar' }]);
    });

    it('getClassName prefers type_identifier', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class Foo {}',
            children: [
                { type: 'type_identifier', text: 'Foo' },
            ],
        });
        expect(KOTLIN_SPEC.getClassName(classNode)).toBe('Foo');
    });

    it('getClassName falls back to simple_identifier when no type_identifier', () => {
        const objNode = mockNode({
            type: 'object_declaration',
            text: 'object Singleton {}',
            children: [
                { type: 'simple_identifier', text: 'Singleton' },
            ],
        });
        expect(KOTLIN_SPEC.getClassName(objNode)).toBe('Singleton');
    });

    it('getClassHierarchy: constructor_invocation becomes extends, plain user_type becomes implements', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class Foo : Bar(), IBaz, IQux',
            children: [
                { type: 'delegation_specifiers', text: ': Bar(), IBaz, IQux', children: [
                    { type: 'constructor_invocation', text: 'Bar()', children: [
                        { type: 'type_identifier', text: 'Bar' },
                    ] },
                    { type: 'user_type', text: 'IBaz', children: [
                        { type: 'type_identifier', text: 'IBaz' },
                    ] },
                    { type: 'user_type', text: 'IQux', children: [
                        { type: 'type_identifier', text: 'IQux' },
                    ] },
                ] },
            ],
        });
        const result = KOTLIN_SPEC.getClassHierarchy!(classNode, 'class Foo : Bar(), IBaz, IQux');
        expect(result.extendsClass).toBe('Bar');
        expect(result.implementsInterfaces).toEqual(['IBaz', 'IQux']);
    });
});
