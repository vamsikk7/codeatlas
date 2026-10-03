/**
 * treeSitterExtractor.test.ts
 *
 * Tests for multi-language symbol extraction using mock Tree-sitter AST nodes.
 * Directly tests extractSymbols() with hand-crafted TSNode trees, bypassing WASM.
 * Also tests extractFileSymbolsMultiLang() when WASM is available (opportunistic).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setGrammarsDir, resetTreeSitterForTesting } from '../treeSitterParser';
import { extractFileSymbolsMultiLang, extractSymbols } from '../treeSitterExtractor';

// ─── Mock TSNode factory ─────────────────────────────────────────────────────

interface MockNodeOpts {
    type: string;
    text: string;
    children?: MockNodeOpts[];
    startIndex?: number;
    endIndex?: number;
}

function mockNode(opts: MockNodeOpts & { _fieldName?: string }, parent: any = null): any {
    const children: any[] = [];
    const node: any = {
        type: opts.type,
        text: opts.text,
        startIndex: opts.startIndex ?? 0,
        endIndex: opts.endIndex ?? opts.text.length,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: opts.text.length },
        children,
        parent,
        previousSibling: null,
        nextSibling: null,
        _fieldName: opts._fieldName,
        childForFieldName: (name: string) => {
            return children.find((c: any) => c._fieldName === name) ?? null;
        },
        descendantsOfType: (types: string | string[]) => {
            const typeArr = Array.isArray(types) ? types : [types];
            const result: any[] = [];
            function walk(n: any) {
                if (typeArr.includes(n.type)) result.push(n);
                for (const c of n.children) walk(c);
            }
            walk(node);
            return result;
        },
    };
    if (opts.children) {
        for (let i = 0; i < opts.children.length; i++) {
            const child = mockNode(opts.children[i] as any, node);
            if (i > 0) {
                child.previousSibling = children[i - 1];
                children[i - 1].nextSibling = child;
            }
            children.push(child);
        }
    }
    return node;
}

/** Attach a field name to a mock node (for childForFieldName lookups) */
function withField(name: string, opts: MockNodeOpts): MockNodeOpts {
    return { ...opts, _fieldName: name } as any;
}

// ─── Direct extraction tests (no WASM needed) ───────────────────────────────

describe('treeSitterExtractor — extractSymbols (mock AST)', () => {

    it('extracts Python class and function', () => {
        const source = `from typing import List
import os
GLOBAL_VAR = "test"
class DataProcessor:
    def __init__(self): pass
def process_data(items):
    return True
`;
        // Mock AST: import_from_statement, import_statement, expression_statement (assignment),
        // class_definition, function_definition
        const root = mockNode({
            type: 'module',
            text: source,
            children: [
                { type: 'import_from_statement', text: 'from typing import List', children: [
                    { type: 'dotted_name', text: 'typing' },
                    { type: 'import', text: 'import' },
                    { type: 'dotted_name', text: 'List' },
                ] },
                { type: 'import_statement', text: 'import os', children: [
                    { type: 'dotted_name', text: 'os' },
                ] },
                { type: 'expression_statement', text: 'GLOBAL_VAR = "test"', children: [
                    { type: 'assignment', text: 'GLOBAL_VAR = "test"', children: [
                        { type: 'identifier', text: 'GLOBAL_VAR' },
                        { type: 'string', text: '"test"' },
                    ] },
                ] },
                { type: 'class_definition', text: 'class DataProcessor:\n    def __init__(self): pass', children: [
                    withField('name', { type: 'identifier', text: 'DataProcessor' }),
                    { type: 'block', text: 'def __init__(self): pass', children: [
                        { type: 'function_definition', text: 'def __init__(self): pass', children: [
                            withField('name', { type: 'identifier', text: '__init__' }),
                            { type: 'parameters', text: '(self)' },
                        ] },
                    ] },
                ] },
                { type: 'function_definition', text: 'def process_data(items):\n    return True', children: [
                    withField('name', { type: 'identifier', text: 'process_data' }),
                    { type: 'parameters', text: '(items)' },
                    { type: 'block', text: 'return True' },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'python', 'main.py');
        expect(analysis.fileName).toBe('main.py');
        expect(analysis.entities.length).toBeGreaterThan(0);
        const names = analysis.entities.map(e => e.name);
        expect(names).toContain('DataProcessor');
        expect(names).toContain('process_data');
    });

    it('extracts Java class and methods', () => {
        const source = 'package com.example;\nimport java.util.List;\npublic class Application {\n    public static void main(String[] args) {\n        System.out.println("Hello");\n    }\n}';
        // Compute exact positions for nodeText() which uses source.slice(startIndex, endIndex)
        const importStart = source.indexOf('import java.util.List;');
        const importEnd = importStart + 'import java.util.List;'.length;
        const classStart = source.indexOf('public class Application');
        const methodStart = source.indexOf('public static void main');
        const methodEnd = source.indexOf('}', source.indexOf('println')) + 1;

        const root = mockNode({
            type: 'program',
            text: source,
            startIndex: 0,
            endIndex: source.length,
            children: [
                { type: 'package_declaration', text: 'package com.example;', startIndex: 0, endIndex: 'package com.example;'.length },
                { type: 'import_declaration', text: 'import java.util.List;', startIndex: importStart, endIndex: importEnd },
                { type: 'class_declaration', text: source.slice(classStart), startIndex: classStart, endIndex: source.length, children: [
                    withField('name', { type: 'identifier', text: 'Application', startIndex: classStart + 13, endIndex: classStart + 24 }),
                    { type: 'class_body', text: '{ ... }', startIndex: classStart + 25, endIndex: source.length, children: [
                        { type: 'method_declaration', text: source.slice(methodStart, methodEnd), startIndex: methodStart, endIndex: methodEnd, children: [
                            withField('name', { type: 'identifier', text: 'main', startIndex: methodStart + 19, endIndex: methodStart + 23 }),
                            withField('parameters', { type: 'formal_parameters', text: '(String[] args)', startIndex: methodStart + 23, endIndex: methodStart + 38 }),
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'java', 'Application.java');
        expect(analysis.entities.length).toBeGreaterThan(0);
        const names = analysis.entities.map(e => e.name);
        expect(names).toContain('Application');
        expect(analysis.importsByLocal.get('List')).toBe('java.util.List');
    });

    it('extracts Go struct and functions', () => {
        const source = `package main
import "fmt"
var Version = "1.0"
type Server struct {}
func main() { fmt.Println(Version) }`;
        const root = mockNode({
            type: 'source_file',
            text: source,
            children: [
                { type: 'package_clause', text: 'package main' },
                { type: 'import_declaration', text: 'import "fmt"', children: [
                    { type: 'import_spec', text: '"fmt"', children: [
                        { type: 'interpreted_string_literal', text: '"fmt"' },
                    ] },
                ] },
                { type: 'var_declaration', text: 'var Version = "1.0"', children: [
                    { type: 'var_spec', text: 'Version = "1.0"', children: [
                        withField('name', { type: 'identifier', text: 'Version' }),
                    ] },
                ] },
                { type: 'type_declaration', text: 'type Server struct {}', children: [
                    { type: 'type_spec', text: 'Server struct {}', children: [
                        withField('name', { type: 'type_identifier', text: 'Server' }),
                        { type: 'struct_type', text: 'struct {}' },
                    ] },
                ] },
                { type: 'function_declaration', text: 'func main() { fmt.Println(Version) }', children: [
                    withField('name', { type: 'identifier', text: 'main' }),
                    { type: 'parameter_list', text: '()' },
                    { type: 'block', text: '{ fmt.Println(Version) }', children: [
                        { type: 'call_expression', text: 'fmt.Println(Version)', children: [
                            { type: 'selector_expression', text: 'fmt.Println' },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'go', 'main.go');
        expect(analysis.entities.length).toBeGreaterThan(0);
        const names = analysis.entities.map(e => e.name);
        expect(names).toContain('Server');
        expect(names).toContain('main');
    });

    /**
     * #489: Go allows multiple methods to share a name on different receivers
     * (`func (u *UserPayload) Bind()` AND `func (a *ArticleRequest) Bind()`).
     * Today both produce flow:&lt;file&gt;:Bind — the second overwrites the first,
     * and baseline-vs-working diff comparisons compare the wrong bodies. Fix:
     * prefix method names with the receiver type so they get distinct flow
     * graph IDs (UserPayload.Bind, ArticleRequest.Bind).
     */
    it('Go method names include receiver type for disambiguation (#489)', () => {
        const source = `package main
func (u *UserPayload) Bind() error { return nil }
func (a *ArticleRequest) Bind() error { return nil }`;
        const root = mockNode({
            type: 'source_file',
            text: source,
            children: [
                { type: 'package_clause', text: 'package main' },
                { type: 'method_declaration', text: 'func (u *UserPayload) Bind() error { return nil }', children: [
                    withField('receiver', { type: 'parameter_list', text: '(u *UserPayload)', children: [
                        { type: 'parameter_declaration', text: 'u *UserPayload', children: [
                            withField('name', { type: 'identifier', text: 'u' }),
                            withField('type', { type: 'pointer_type', text: '*UserPayload', children: [
                                { type: 'type_identifier', text: 'UserPayload' },
                            ] }),
                        ] },
                    ] }),
                    withField('name', { type: 'identifier', text: 'Bind' }),
                    { type: 'parameter_list', text: '()' },
                    { type: 'block', text: '{ return nil }' },
                ] },
                { type: 'method_declaration', text: 'func (a *ArticleRequest) Bind() error { return nil }', children: [
                    withField('receiver', { type: 'parameter_list', text: '(a *ArticleRequest)', children: [
                        { type: 'parameter_declaration', text: 'a *ArticleRequest', children: [
                            withField('name', { type: 'identifier', text: 'a' }),
                            withField('type', { type: 'pointer_type', text: '*ArticleRequest', children: [
                                { type: 'type_identifier', text: 'ArticleRequest' },
                            ] }),
                        ] },
                    ] }),
                    withField('name', { type: 'identifier', text: 'Bind' }),
                    { type: 'parameter_list', text: '()' },
                    { type: 'block', text: '{ return nil }' },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'go', 'main.go');
        const names = analysis.entities.map(e => e.name);
        expect(names).toContain('UserPayload.Bind');
        expect(names).toContain('ArticleRequest.Bind');
        // Bare `Bind` should NOT be in the entity list (would cause collision).
        expect(names.includes('Bind')).toBe(false);
    });

    it('extracts Rust struct and function', () => {
        const source = `use std::collections::HashMap;
struct Config { name: String }
fn process(config: &Config) -> bool { true }`;
        const root = mockNode({
            type: 'source_file',
            text: source,
            children: [
                { type: 'use_declaration', text: 'use std::collections::HashMap;', children: [
                    { type: 'scoped_identifier', text: 'std::collections::HashMap' },
                ] },
                { type: 'struct_item', text: 'struct Config { name: String }', children: [
                    withField('name', { type: 'type_identifier', text: 'Config' }),
                    { type: 'field_declaration_list', text: '{ name: String }' },
                ] },
                { type: 'function_item', text: 'fn process(config: &Config) -> bool { true }', children: [
                    withField('name', { type: 'identifier', text: 'process' }),
                    { type: 'parameters', text: '(config: &Config)' },
                    { type: 'block', text: '{ true }' },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'rust', 'lib.rs');
        expect(analysis.entities.length).toBeGreaterThan(0);
        const names = analysis.entities.map(e => e.name);
        expect(names).toContain('Config');
        expect(names).toContain('process');
    });

    it('extracts PHP class', () => {
        const source = `<?php
namespace App\\Controllers;
use App\\Models\\User;
class UserController {
    public function index(): array { return User::all(); }
}`;
        const root = mockNode({
            type: 'program',
            text: source,
            children: [
                { type: 'php_tag', text: '<?php' },
                { type: 'namespace_definition', text: 'namespace App\\Controllers;', children: [
                    { type: 'namespace_name', text: 'App\\Controllers' },
                ] },
                { type: 'namespace_use_declaration', text: 'use App\\Models\\User;', children: [
                    { type: 'namespace_use_clause', text: 'App\\Models\\User', children: [
                        { type: 'qualified_name', text: 'App\\Models\\User', children: [
                            { type: 'namespace_name', text: 'App\\Models\\User' },
                        ] },
                    ] },
                ] },
                { type: 'class_declaration', text: 'class UserController { ... }', children: [
                    withField('name', { type: 'name', text: 'UserController' }),
                    { type: 'declaration_list', text: '{ ... }', children: [
                        { type: 'method_declaration', text: 'public function index(): array { return User::all(); }', children: [
                            withField('name', { type: 'name', text: 'index' }),
                            { type: 'formal_parameters', text: '()' },
                            { type: 'compound_statement', text: '{ return User::all(); }' },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'php', 'UserController.php');
        expect(analysis.entities.length).toBeGreaterThan(0);
        expect(analysis.entities.map(e => e.name)).toContain('UserController');
    });

    it('extracts Ruby class', () => {
        const source = `require 'json'
class TodoService
  def list_all; end
  def create(data); end
end`;
        const root = mockNode({
            type: 'program',
            text: source,
            children: [
                { type: 'call', text: "require 'json'", children: [
                    { type: 'identifier', text: 'require' },
                    { type: 'argument_list', text: "'json'", children: [
                        { type: 'string', text: "'json'" },
                    ] },
                ] },
                { type: 'class', text: 'class TodoService\n  def list_all; end\n  def create(data); end\nend', children: [
                    withField('name', { type: 'constant', text: 'TodoService' }),
                    { type: 'body_statement', text: 'def list_all; end\n  def create(data); end', children: [
                        { type: 'method', text: 'def list_all; end', children: [
                            withField('name', { type: 'identifier', text: 'list_all' }),
                        ] },
                        { type: 'method', text: 'def create(data); end', children: [
                            withField('name', { type: 'identifier', text: 'create' }),
                            { type: 'method_parameters', text: '(data)' },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'ruby', 'todo_service.rb');
        expect(analysis.entities.length).toBeGreaterThan(0);
        expect(analysis.entities.map(e => e.name)).toContain('TodoService');
    });

    it('extracts Swift class', () => {
        const source = `import Foundation
class TodoController {
    func index() -> [String] { return [] }
}`;
        const root = mockNode({
            type: 'source_file',
            text: source,
            children: [
                { type: 'import_declaration', text: 'import Foundation', children: [
                    { type: 'identifier', text: 'Foundation' },
                ] },
                { type: 'class_declaration', text: 'class TodoController { ... }', children: [
                    withField('name', { type: 'type_identifier', text: 'TodoController' }),
                    { type: 'class_body', text: '{ ... }', children: [
                        { type: 'function_declaration', text: 'func index() -> [String] { return [] }', children: [
                            withField('name', { type: 'simple_identifier', text: 'index' }),
                            { type: 'parameter_clause', text: '()' },
                            { type: 'code_block', text: '{ return [] }' },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'swift', 'TodoController.swift');
        expect(analysis.entities.length).toBeGreaterThan(0);
        expect(analysis.entities.map(e => e.name)).toContain('TodoController');
    });

    it('extracts C# class', () => {
        const source = `using System;
namespace App {
    public class Program {
        public static void Main(string[] args) { Console.WriteLine("Hello"); }
    }
}`;
        const root = mockNode({
            type: 'compilation_unit',
            text: source,
            children: [
                { type: 'using_directive', text: 'using System;', children: [
                    { type: 'identifier', text: 'System' },
                ] },
                { type: 'namespace_declaration', text: 'namespace App { ... }', children: [
                    withField('name', { type: 'identifier', text: 'App' }),
                    { type: 'declaration_list', text: '{ ... }', children: [
                        { type: 'class_declaration', text: 'public class Program { ... }', children: [
                            withField('name', { type: 'identifier', text: 'Program' }),
                            { type: 'declaration_list', text: '{ ... }', children: [
                                { type: 'method_declaration', text: 'public static void Main(string[] args) { Console.WriteLine("Hello"); }', children: [
                                    withField('name', { type: 'identifier', text: 'Main' }),
                                    { type: 'parameter_list', text: '(string[] args)' },
                                    { type: 'block', text: '{ Console.WriteLine("Hello"); }' },
                                ] },
                            ] },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'csharp', 'Program.cs');
        expect(analysis.entities.length).toBeGreaterThan(0);
        const names = analysis.entities.map(e => e.name);
        expect(names.length).toBeGreaterThan(0);
    });

    /**
     * #444-C: C# nested class — `class Create { class Handler { Handle() {} } }`.
     * Today the inner method is keyed only by its immediate parent (Handler.Handle).
     * For MediatR-pattern code the OUTER class name (Create) is the meaningful
     * route identifier; we want fully-qualified `Create.Handler.Handle` so the
     * flow graph carries both class names.
     */
    it('extracts C# nested class with fully-qualified method name (#444-C)', () => {
        const source = `public class Create {
    public class Handler {
        public async Task Handle(Create command) { return; }
    }
}`;
        const root = mockNode({
            type: 'compilation_unit',
            text: source,
            children: [
                { type: 'class_declaration', text: 'public class Create { ... }', children: [
                    withField('name', { type: 'identifier', text: 'Create' }),
                    withField('body', { type: 'declaration_list', text: '{ ... }', children: [
                        { type: 'class_declaration', text: 'public class Handler { ... }', children: [
                            withField('name', { type: 'identifier', text: 'Handler' }),
                            withField('body', { type: 'declaration_list', text: '{ ... }', children: [
                                { type: 'method_declaration', text: 'public async Task Handle(Create command) { return; }', children: [
                                    withField('name', { type: 'identifier', text: 'Handle' }),
                                    { type: 'parameter_list', text: '(Create command)' },
                                    { type: 'block', text: '{ return; }' },
                                ] },
                            ] }),
                        ] },
                    ] }),
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'csharp', 'Create.cs');
        const names = analysis.entities.map(e => e.name);
        // Outer class and inner class are both registered as `class` entities.
        expect(names).toContain('Create');
        // Method name must include BOTH outer and inner class names.
        expect(names).toContain('Create.Handler.Handle');
    });

    it('extracts Kotlin class', () => {
        const source = `package com.example
import java.util.UUID
class UserService {
    fun getUser(id: String): String = "user"
}`;
        const root = mockNode({
            type: 'source_file',
            text: source,
            children: [
                { type: 'package_header', text: 'package com.example' },
                { type: 'import_header', text: 'import java.util.UUID', children: [
                    { type: 'identifier', text: 'java.util.UUID' },
                ] },
                { type: 'class_declaration', text: 'class UserService { ... }', children: [
                    withField('name', { type: 'type_identifier', text: 'UserService' }),
                    { type: 'class_body', text: '{ ... }', children: [
                        { type: 'function_declaration', text: 'fun getUser(id: String): String = "user"', children: [
                            withField('name', { type: 'simple_identifier', text: 'getUser' }),
                            { type: 'function_value_parameters', text: '(id: String)' },
                        ] },
                    ] },
                ] },
            ],
        });

        const analysis = extractSymbols({ rootNode: root }, source, 'kotlin', 'UserService.kt');
        expect(analysis.entities.length).toBeGreaterThan(0);
        expect(analysis.entities.map(e => e.name)).toContain('UserService');
    });

    it('returns valid FileAnalysis shape for all languages', () => {
        const emptyRoot = mockNode({ type: 'source_file', text: '', children: [] });
        for (const lang of ['python', 'java', 'go', 'rust', 'kotlin', 'php', 'ruby', 'swift', 'csharp'] as const) {
            const analysis = extractSymbols({ rootNode: emptyRoot }, '', lang, `test.${lang}`);
            expect(analysis).toHaveProperty('entities');
            expect(analysis).toHaveProperty('funcs');
            expect(analysis).toHaveProperty('vars');
            expect(analysis).toHaveProperty('importsByLocal');
            expect(analysis).toHaveProperty('injectedDeps');
            expect(Array.isArray(analysis.entities)).toBe(true);
        }
    });
});

// ─── Opportunistic WASM tests (run when WASM is available) ───────────────────

const grammarsPath = path.join(process.cwd(), 'grammars');
let wasmReady = false;

beforeAll(async () => {
    const distWasm = path.join(process.cwd(), 'dist', 'tree-sitter.wasm');
    if (!fs.existsSync(distWasm) || !fs.existsSync(grammarsPath)) return;

    try {
        resetTreeSitterForTesting();
        setGrammarsDir(grammarsPath);
        const probe = await extractFileSymbolsMultiLang('def hello():\n    pass\n', 'probe.py', 'python');
        wasmReady = probe.entities.length > 0;
    } catch { /* WASM unavailable in this environment */ }
});

describe('treeSitterExtractor — WASM integration (opportunistic)', () => {
    it('extractFileSymbolsMultiLang produces entities when WASM available', async () => {
        if (!wasmReady) return; // gracefully skip in CI without WASM

        const source = `
import java.util.List;
public class Application {
    public static void main(String[] args) {}
}`;
        const analysis = await extractFileSymbolsMultiLang(source, 'Application.java', 'java');
        expect(analysis.entities.length).toBeGreaterThan(0);
        expect(analysis.entities.map(e => e.name)).toContain('Application');
    });
});
