/**
 * specs/__tests__/swift.test.ts — Unit tests for SWIFT_SPEC.
 *
 * Covers the swift class-vs-protocol disambiguation: only
 * `class_declaration` gets a superclass slot; `struct_declaration` and
 * `enum_declaration` put all conformances into `implementsInterfaces`.
 */

import { describe, it, expect } from 'vitest';
import { SWIFT_SPEC } from '../swift';
import { mockNode } from './_mock';

describe('SWIFT_SPEC', () => {
    it('extracts import declaration', () => {
        const src = 'import UIKit';
        const node = mockNode({
            type: 'import_declaration',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = SWIFT_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'UIKit', source: 'UIKit' }]);
    });

    it('class_declaration: first inheritance is extends, rest are protocols', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class FooViewController: UIViewController, UITableViewDelegate {}',
            children: [
                { type: 'type_inheritance_clause', text: ': UIViewController, UITableViewDelegate', children: [
                    { type: 'type_identifier', text: 'UIViewController' },
                    { type: 'type_identifier', text: 'UITableViewDelegate' },
                ] },
            ],
        });
        const result = SWIFT_SPEC.getClassHierarchy!(classNode, 'class FooViewController: UIViewController, UITableViewDelegate {}');
        expect(result.extendsClass).toBe('UIViewController');
        expect(result.implementsInterfaces).toEqual(['UITableViewDelegate']);
    });

    it('struct_declaration: all conformances are protocols (no extends)', () => {
        const structNode = mockNode({
            type: 'struct_declaration',
            text: 'struct FooView: View, Equatable {}',
            children: [
                { type: 'type_inheritance_clause', text: ': View, Equatable', children: [
                    { type: 'type_identifier', text: 'View' },
                    { type: 'type_identifier', text: 'Equatable' },
                ] },
            ],
        });
        const result = SWIFT_SPEC.getClassHierarchy!(structNode, 'struct FooView: View, Equatable {}');
        expect(result.extendsClass).toBeUndefined();
        expect(result.implementsInterfaces).toEqual(['View', 'Equatable']);
    });

    it('protocol + enum + struct are all classTypes', () => {
        expect(SWIFT_SPEC.classTypes).toEqual(expect.arrayContaining([
            'class_declaration', 'struct_declaration', 'protocol_declaration', 'enum_declaration',
        ]));
    });
});
