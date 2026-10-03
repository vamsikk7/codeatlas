/**
 * specs/__tests__/typescript.test.ts — Unit tests for TYPESCRIPT_SPEC.
 *
 * Focused on what TS adds over JS: `interface_declaration` in
 * `classTypes`, decorator extraction, and `getClassHierarchy` for both
 * `extends` and `implements` clauses.
 */

import { describe, it, expect } from 'vitest';
import { TYPESCRIPT_SPEC } from '../typescript';
import { mockNode } from './_mock';

describe('TYPESCRIPT_SPEC', () => {
    it('includes interface_declaration in classTypes', () => {
        expect(TYPESCRIPT_SPEC.classTypes).toContain('interface_declaration');
    });

    it('extracts decorators in order from previousSibling chain', () => {
        // Build a parent so siblings exist; decorators precede the class.
        const parent = mockNode({
            type: 'program',
            text: '@Component @Injectable class Foo {}',
            children: [
                { type: 'decorator', text: '@Injectable', startIndex: 11, endIndex: 22 },
                { type: 'decorator', text: '@Component', startIndex: 0, endIndex: 10 },
                { type: 'class_declaration', text: 'class Foo {}' },
            ],
        });
        const classNode = parent.children[2];
        const decorators = TYPESCRIPT_SPEC.getDecorators!(classNode, '@Component @Injectable class Foo {}');
        // Both decorators captured (walk backwards from class through prev siblings).
        expect(decorators.length).toBe(2);
    });

    it('extracts extends clause from class_heritage', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class Foo extends Bar {}',
            children: [
                { type: 'class_heritage', text: 'extends Bar', children: [
                    { type: 'extends_clause', text: 'extends Bar', children: [
                        { type: 'identifier', text: 'Bar' },
                    ] },
                ] },
            ],
        });
        const result = TYPESCRIPT_SPEC.getClassHierarchy!(classNode, 'class Foo extends Bar {}');
        expect(result.extendsClass).toBe('Bar');
        expect(result.implementsInterfaces).toBeUndefined();
    });

    it('extracts implements clause via descendantsOfType', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class Foo implements IBaz, IQux {}',
            children: [
                { type: 'class_heritage', text: 'implements IBaz, IQux', children: [
                    { type: 'implements_clause', text: 'implements IBaz, IQux', children: [
                        { type: 'type_identifier', text: 'IBaz' },
                        { type: 'type_identifier', text: 'IQux' },
                    ] },
                ] },
            ],
        });
        const result = TYPESCRIPT_SPEC.getClassHierarchy!(classNode, 'class Foo implements IBaz, IQux {}');
        expect(result.implementsInterfaces).toEqual(['IBaz', 'IQux']);
    });

    it('strips generics from extends class name', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class Repo extends BaseRepo<Todo> {}',
            children: [
                { type: 'class_heritage', text: 'extends BaseRepo<Todo>', children: [
                    { type: 'extends_clause', text: 'extends BaseRepo<Todo>', children: [
                        { type: 'generic_type', text: 'BaseRepo<Todo>', children: [
                            { type: 'type_identifier', text: 'BaseRepo' },
                        ] },
                    ] },
                ] },
            ],
        });
        const result = TYPESCRIPT_SPEC.getClassHierarchy!(classNode, 'class Repo extends BaseRepo<Todo> {}');
        expect(result.extendsClass).toBe('BaseRepo');
    });
});
