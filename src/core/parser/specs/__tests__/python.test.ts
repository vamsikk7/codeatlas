/**
 * specs/__tests__/python.test.ts — Unit tests for PYTHON_SPEC.
 *
 * Covers Python's three DI-specific accessors that the dispatcher-level
 * tests don't drill into: `getFieldDependencies`, `getFunctionDependencies`
 * (FastAPI `Depends`), and `getLocalVarTypes` (assignment-result tracking
 * for `todo = Todo.objects.get(...)`).
 */

import { describe, it, expect } from 'vitest';
import { PYTHON_SPEC } from '../python';
import { mockNode, withField } from './_mock';

describe('PYTHON_SPEC', () => {
    it('extracts import_statement form (`import os`)', () => {
        const node = mockNode({
            type: 'import_statement',
            text: 'import os',
            children: [
                { type: 'dotted_name', text: 'os' },
            ],
        });
        const imports = PYTHON_SPEC.getImports(node, 'import os');
        expect(imports).toEqual([{ local: 'os', source: 'os' }]);
    });

    it('extracts import_from_statement with multiple names', () => {
        const node = mockNode({
            type: 'import_from_statement',
            text: 'from typing import List, Optional',
            children: [
                withField('module_name', { type: 'dotted_name', text: 'typing' }),
                { type: 'dotted_name', text: 'List' },
                { type: 'dotted_name', text: 'Optional' },
            ],
        });
        const imports = PYTHON_SPEC.getImports(node, 'from typing import List, Optional');
        // First dotted_name is the module; subsequent dotted_names are the imported names.
        // Implementation iterates children and excludes the field-matched module.
        const locals = imports.map(i => i.local);
        expect(locals).toEqual(expect.arrayContaining(['List', 'Optional']));
    });

    it('getClassHierarchy treats first superclass as extends, rest as implements', () => {
        const classNode = mockNode({
            type: 'class_definition',
            text: 'class Dog(Animal, Serializable, Loggable): pass',
            children: [
                withField('superclasses', {
                    type: 'argument_list',
                    text: '(Animal, Serializable, Loggable)',
                    children: [
                        { type: 'identifier', text: 'Animal' },
                        { type: 'identifier', text: 'Serializable' },
                        { type: 'identifier', text: 'Loggable' },
                    ],
                }),
            ],
        });
        const result = PYTHON_SPEC.getClassHierarchy!(classNode, 'class Dog(Animal, Serializable, Loggable): pass');
        expect(result.extendsClass).toBe('Animal');
        expect(result.implementsInterfaces).toEqual(['Serializable', 'Loggable']);
    });

    it('getFieldDependencies skips builtin types and lowercase identifiers', () => {
        const classBody = mockNode({
            type: 'block',
            text: 'service: TodoService\ncount: int\nname: str',
            children: [
                { type: 'annotated_assignment', text: 'service: TodoService', children: [
                    { type: 'identifier', text: 'service' },
                    { type: 'identifier', text: 'TodoService' },
                ] },
                { type: 'annotated_assignment', text: 'count: int', children: [
                    { type: 'identifier', text: 'count' },
                    { type: 'identifier', text: 'int' },
                ] },
            ],
        });
        const result = PYTHON_SPEC.getFieldDependencies!(classBody, new Map([['TodoService', 'app.services.todo']]));
        expect(result).toEqual([{ local: 'service', source: 'app.services.todo' }]);
    });

    it('getFunctionDependencies extracts FastAPI Depends-style typed params (Issue 728)', () => {
        // Tree-sitter Python shape for `def list_todos(service: TodoService)`:
        //   function_definition
        //     parameters
        //       typed_parameter
        //         identifier 'service'
        //         identifier 'TodoService'  (the type annotation)
        const fnNode = mockNode({
            type: 'function_definition',
            text: 'def list_todos(service: TodoService): pass',
            children: [
                withField('parameters', { type: 'parameters', text: '(service: TodoService)', children: [
                    { type: 'typed_parameter', text: 'service: TodoService', children: [
                        { type: 'identifier', text: 'service' },
                        { type: 'identifier', text: 'TodoService' },
                    ] },
                ] }),
            ],
        });
        const result = PYTHON_SPEC.getFunctionDependencies!(fnNode, new Map([['TodoService', 'app.services.todo']]));
        expect(result).toEqual([{ local: 'service', source: 'app.services.todo' }]);
    });

    it('getFunctionDependencies skips `self` parameter', () => {
        const fnNode = mockNode({
            type: 'function_definition',
            text: 'def foo(self): pass',
            children: [
                withField('parameters', { type: 'parameters', text: '(self)', children: [
                    { type: 'typed_parameter', text: 'self', children: [
                        { type: 'identifier', text: 'self' },
                    ] },
                ] }),
            ],
        });
        const result = PYTHON_SPEC.getFunctionDependencies!(fnNode, new Map());
        expect(result).toEqual([]);
    });

    it('getFunctionDependencies returns empty when function has no `parameters` field', () => {
        // Defensive guard: handler returns `[]` instead of throwing on missing field.
        const fnNode = mockNode({
            type: 'function_definition',
            text: 'def list_todos(): pass',
        });
        const result = PYTHON_SPEC.getFunctionDependencies!(fnNode, new Map());
        expect(result).toEqual([]);
    });
});
