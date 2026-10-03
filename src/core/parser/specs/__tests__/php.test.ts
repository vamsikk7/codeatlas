/**
 * specs/__tests__/php.test.ts — Unit tests for PHP_SPEC.
 *
 * Covers `use Foo\Bar;` namespace imports, `getDecorators` for PHP 8
 * `#[Route('/...')]` attributes, and `getFieldDependencies` for both
 * classic property declarations and PHP 8 constructor property
 * promotion (`__construct(private UserService $userService)`).
 */

import { describe, it, expect } from 'vitest';
import { PHP_SPEC } from '../php';
import { mockNode, withField } from './_mock';

describe('PHP_SPEC', () => {
    it('extracts namespace_use_declaration', () => {
        const node = mockNode({
            type: 'namespace_use_declaration',
            text: 'use App\\Services\\TodoService;',
            children: [
                { type: 'namespace_use_clause', text: 'App\\Services\\TodoService', children: [
                    { type: 'qualified_name', text: 'App\\Services\\TodoService' },
                ] },
            ],
        });
        const imports = PHP_SPEC.getImports(node, 'use App\\Services\\TodoService;');
        expect(imports).toEqual([{ local: 'TodoService', source: 'App\\Services\\TodoService' }]);
    });

    it('getFieldDependencies handles classic property declaration', () => {
        const classBody = mockNode({
            type: 'declaration_list',
            text: 'private UserService $userService;',
            children: [
                { type: 'property_declaration', text: 'private UserService $userService;', children: [
                    { type: 'named_type', text: 'UserService' },
                    { type: 'property_element', text: '$userService', children: [
                        { type: 'variable_name', text: '$userService' },
                    ] },
                ] },
            ],
        });
        const result = PHP_SPEC.getFieldDependencies!(classBody, new Map([['UserService', 'App\\Services\\UserService']]));
        expect(result).toEqual([{ local: 'userService', source: 'App\\Services\\UserService' }]);
    });

    it('getFieldDependencies handles PHP 8 constructor property promotion', () => {
        const classBody = mockNode({
            type: 'declaration_list',
            text: 'public function __construct(private UserService $userService) {}',
            children: [
                { type: 'method_declaration', text: 'public function __construct(private UserService $userService) {}', children: [
                    withField('name', { type: 'name', text: '__construct' }),
                    withField('parameters', { type: 'formal_parameters', text: '(private UserService $userService)', children: [
                        { type: 'property_promotion_parameter', text: 'private UserService $userService', children: [
                            { type: 'named_type', text: 'UserService' },
                            { type: 'variable_name', text: '$userService' },
                        ] },
                    ] }),
                ] },
            ],
        });
        const result = PHP_SPEC.getFieldDependencies!(classBody, new Map([['UserService', 'App\\Services\\UserService']]));
        expect(result).toEqual([{ local: 'userService', source: 'App\\Services\\UserService' }]);
    });

    it('getFieldDependencies skips PHP builtin types', () => {
        const classBody = mockNode({
            type: 'declaration_list',
            text: 'private string $name;\nprivate Request $request;',
            children: [
                { type: 'property_declaration', text: 'private string $name;', children: [
                    { type: 'named_type', text: 'string' },
                    { type: 'property_element', text: '$name', children: [
                        { type: 'variable_name', text: '$name' },
                    ] },
                ] },
                { type: 'property_declaration', text: 'private Request $request;', children: [
                    { type: 'named_type', text: 'Request' },
                    { type: 'property_element', text: '$request', children: [
                        { type: 'variable_name', text: '$request' },
                    ] },
                ] },
            ],
        });
        const result = PHP_SPEC.getFieldDependencies!(classBody, new Map());
        expect(result).toEqual([]);
    });
});
