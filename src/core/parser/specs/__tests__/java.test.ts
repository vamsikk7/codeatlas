/**
 * specs/__tests__/java.test.ts — Unit tests for JAVA_SPEC.
 *
 * Covers Java's `getImports` regex (handles `import static`),
 * `getFieldDependencies` (Spring @Autowired field injection — uses
 * field variable name as local key for BFS receiver resolution), and
 * `getClassHierarchy` with superclass field + interfaces field.
 */

import { describe, it, expect } from 'vitest';
import { JAVA_SPEC } from '../java';
import { mockNode, withField } from './_mock';

describe('JAVA_SPEC', () => {
    it('extracts plain import declaration', () => {
        const src = 'import com.example.foo.Bar;';
        const node = mockNode({
            type: 'import_declaration',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = JAVA_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'Bar', source: 'com.example.foo.Bar' }]);
    });

    it('extracts static import', () => {
        const src = 'import static org.junit.Assert.assertEquals;';
        const node = mockNode({
            type: 'import_declaration',
            text: src,
            startIndex: 0,
            endIndex: src.length,
        });
        const imports = JAVA_SPEC.getImports(node, src);
        expect(imports).toEqual([{ local: 'assertEquals', source: 'org.junit.Assert.assertEquals' }]);
    });

    it('extracts class hierarchy with superclass + interfaces', () => {
        const classNode = mockNode({
            type: 'class_declaration',
            text: 'class TodoServiceImpl extends BaseService implements TodoService, Closeable {}',
            children: [
                withField('superclass', { type: 'superclass', text: 'extends BaseService', children: [
                    { type: 'type_identifier', text: 'BaseService' },
                ] }),
                withField('interfaces', { type: 'super_interfaces', text: 'implements TodoService, Closeable', children: [
                    { type: 'type_identifier', text: 'TodoService' },
                    { type: 'type_identifier', text: 'Closeable' },
                ] }),
            ],
        });
        const result = JAVA_SPEC.getClassHierarchy!(classNode, 'class TodoServiceImpl extends BaseService implements TodoService, Closeable {}');
        expect(result.extendsClass).toBe('BaseService');
        expect(result.implementsInterfaces).toEqual(['TodoService', 'Closeable']);
    });

    it('getFieldDependencies maps field variable name to import source', () => {
        const classBody = mockNode({
            type: 'class_body',
            text: 'private TodoService todoService;',
            children: [
                { type: 'field_declaration', text: 'private TodoService todoService;', children: [
                    withField('type', { type: 'type_identifier', text: 'TodoService' }),
                    { type: 'variable_declarator', text: 'todoService', children: [
                        withField('name', { type: 'identifier', text: 'todoService' }),
                    ] },
                ] },
            ],
        });
        const result = JAVA_SPEC.getFieldDependencies!(classBody, new Map([['TodoService', 'com.example.TodoService']]));
        // Use field variable name as local key (not the type), so receiver-call BFS can resolve `todoService.foo()`.
        expect(result).toEqual([{ local: 'todoService', source: 'com.example.TodoService' }]);
    });

    it('getFieldDependencies skips Java built-in types (String, List, Optional)', () => {
        const classBody = mockNode({
            type: 'class_body',
            text: 'private String name;\nprivate List items;',
            children: [
                { type: 'field_declaration', text: 'private String name;', children: [
                    withField('type', { type: 'type_identifier', text: 'String' }),
                    { type: 'variable_declarator', text: 'name', children: [
                        withField('name', { type: 'identifier', text: 'name' }),
                    ] },
                ] },
                { type: 'field_declaration', text: 'private List items;', children: [
                    withField('type', { type: 'type_identifier', text: 'List' }),
                    { type: 'variable_declarator', text: 'items', children: [
                        withField('name', { type: 'identifier', text: 'items' }),
                    ] },
                ] },
            ],
        });
        const result = JAVA_SPEC.getFieldDependencies!(classBody, new Map());
        expect(result).toEqual([]);
    });
});
