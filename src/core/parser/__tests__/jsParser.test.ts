import { describe, it, expect } from 'vitest';
import { parseJS, parseJSAuto, detectSourceType } from '../jsParser';

describe('jsParser', () => {
    it('should parse simple ES module code', () => {
        const code = `import x from 'y';\nconst a = 1;`;
        const ast = parseJS(code, true);

        expect(ast.type).toBe('File');
        expect(ast.program.body).toHaveLength(2);
        expect(ast.program.body[0].type).toBe('ImportDeclaration');
        expect(ast.program.body[1].type).toBe('VariableDeclaration');
    });

    it('should parse CommonJS code', () => {
        const code = `const x = require('y');\nmodule.exports = x;`;
        const ast = parseJS(code, false);

        expect(ast.type).toBe('File');
        expect(ast.program.body.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse JSX syntax', () => {
        const code = `const App = () => <div>Hello</div>;`;
        const ast = parseJS(code, true);

        expect(ast.type).toBe('File');
        expect(ast.program.body).toHaveLength(1);
    });

    it('should parse optional chaining', () => {
        const code = `const x = obj?.nested?.value;`;
        const ast = parseJS(code, true);

        expect(ast.type).toBe('File');
        expect(ast.program.body).toHaveLength(1);
    });

    it('should parse nullish coalescing', () => {
        const code = `const x = a ?? 'default';`;
        const ast = parseJS(code, true);

        expect(ast.type).toBe('File');
        expect(ast.program.body).toHaveLength(1);
    });

    it('should detect module source type', () => {
        expect(detectSourceType(`import x from 'y';`)).toBe('module');
        expect(detectSourceType(`export default x;`)).toBe('module');
        expect(detectSourceType(`const x = require('y');`)).toBe('script');
    });

    it('parseJSAuto should handle ES modules automatically', () => {
        const code = `import express from 'express';\nconst app = express();`;
        const ast = parseJSAuto(code);

        expect(ast.type).toBe('File');
        expect(ast.program.body[0].type).toBe('ImportDeclaration');
    });

    it('should handle dynamic imports', () => {
        const code = `const mod = await import('./module.js');`;
        const ast = parseJS(code, true);
        expect(ast.type).toBe('File');
    });

    it('should parse arrow functions', () => {
        const code = `const fn = (a, b) => a + b;`;
        const ast = parseJS(code, true);

        expect(ast.program.body).toHaveLength(1);
        expect(ast.program.body[0].type).toBe('VariableDeclaration');
    });

    it('should parse class declarations', () => {
        const code = `class Foo { bar() { return 42; } }`;
        const ast = parseJS(code, true);

        expect(ast.program.body).toHaveLength(1);
        expect(ast.program.body[0].type).toBe('ClassDeclaration');
    });

    it('should handle parse errors gracefully with error recovery', () => {
        const code = `const x = ;`; // syntax error
        // Babel may throw even with errorRecovery on severe syntax errors
        // Verify the error is catchable
        try {
            const ast = parseJS(code, true);
            expect(ast.type).toBe('File');
        } catch (e: any) {
            expect(e).toBeDefined();
            expect(e.message).toContain('Unexpected token');
        }
    });
});
