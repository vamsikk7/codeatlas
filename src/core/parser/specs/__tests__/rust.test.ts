/**
 * specs/__tests__/rust.test.ts — Unit tests for RUST_SPEC.
 *
 * Focused on the Issue #262 `use` parsing — three shapes:
 *   - wildcard `use foo::bar::*;`
 *   - brace group `use foo::{Bar, Baz as Qux};`
 *   - plain path `use std::io;` (with optional `as` rename)
 */

import { describe, it, expect } from 'vitest';
import { RUST_SPEC } from '../rust';
import { mockNode } from './_mock';

function useDecl(src: string) {
    return mockNode({
        type: 'use_declaration',
        text: src,
        startIndex: 0,
        endIndex: src.length,
    });
}

describe('RUST_SPEC', () => {
    it('extracts wildcard use', () => {
        const src = 'use foo::bar::*;';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([{ local: '*', source: 'foo::bar' }]);
    });

    it('extracts brace group use with multiple items', () => {
        const src = 'use casbin::{CoreApi, Enforcer};';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([
            { local: 'CoreApi', source: 'casbin' },
            { local: 'Enforcer', source: 'casbin' },
        ]);
    });

    it('brace group use honors `as` rename (Issue 729)', () => {
        const src = 'use foo::{Bar as Renamed, Quux};';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([
            { local: 'Renamed', source: 'foo' },
            { local: 'Quux', source: 'foo' },
        ]);
    });

    it('filters `self` from brace group items', () => {
        const src = 'use foo::{self, Bar};';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([{ local: 'Bar', source: 'foo' }]);
    });

    it('extracts plain path use', () => {
        const src = 'use std::io;';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([{ local: 'io', source: 'std::io' }]);
    });

    it('extracts plain path use with `as` rename', () => {
        const src = 'use std::io as IO;';
        const imports = RUST_SPEC.getImports(useDecl(src), src);
        expect(imports).toEqual([{ local: 'IO', source: 'std::io' }]);
    });
});
