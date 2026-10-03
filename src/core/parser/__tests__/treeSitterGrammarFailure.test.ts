/**
 * treeSitterGrammarFailure.test.ts — #903
 *
 * `extractFileSymbolsMultiLang` documents `@throws Never`, but the non-Dart path
 * called `parseSource` with no try/catch — a missing/failed grammar `.wasm`
 * threw to the caller (the swallowed `[Rebuild] Failed` class). This pins the
 * contract: a grammar failure degrades to an empty best-effort analysis.
 *
 * We mock `parseSource` to throw (simulating a missing `tree-sitter-go.wasm`)
 * while keeping the real `LANGUAGE_SPECS` (from a different module) so 'go'
 * still has a spec and the code reaches the now-guarded parse call.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../treeSitterParser', async () => {
    const actual = await vi.importActual<any>('../treeSitterParser');
    return {
        ...actual,
        parseSource: vi.fn(async () => { throw new Error('simulated missing tree-sitter-go.wasm'); }),
    };
});

import { extractFileSymbolsMultiLang } from '../treeSitterExtractor';

describe('#903 — grammar load/parse failure degrades to empty analysis (no throw)', () => {
    it('a failing grammar yields empty entities, does NOT throw', async () => {
        // 'go' has a LANGUAGE_SPEC, so execution reaches the (mocked-to-throw) parse.
        const result = await extractFileSymbolsMultiLang('package main\nfunc main() {}', 'main.go', 'go');
        expect(result.entities).toEqual([]);
        expect(result.funcs.size).toBe(0);
        expect(result.vars.size).toBe(0);
        expect(result.fileName).toBe('main.go');
    });

    it('the @throws Never contract holds — the promise resolves, never rejects', async () => {
        await expect(extractFileSymbolsMultiLang('fn main() {}', 'a.rs', 'rust')).resolves.toBeTruthy();
    });
});
