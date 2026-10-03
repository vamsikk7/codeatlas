/**
 * dependencyContext.ts — #946 dependency-aware diff context.
 *
 * When a PR changes a symbol (function / method / class / interface), the
 * reviewer sees only the changed file. The bugs that survive (the "cross-file
 * contract" miss bucket) live in OTHER files: a caller that assumes the old
 * return shape, a sibling interface implementer that didn't update its
 * signature, a test that asserts the old behaviour.
 *
 * This module walks the workspace call graph + symbol table to attach, for each
 * changed file, a compact DEPENDENTS pack:
 *   - caller      — a function in another file that calls a symbol defined here
 *   - implementer — a class elsewhere that implements/extends a type defined here
 *   - sibling-impl — another implementer of an interface THIS file's class implements
 *   - test        — a test/spec file that references this file or its symbols
 *
 * Snippets are span-sliced from the working content and byte-bounded so the
 * extra context stays cheap. Pure read-only; never throws (graceful empty).
 */

import { WorkspaceCallGraph } from '../graph/callGraphResolver';
import type { SymbolRecord } from '../graph/graphTypes';

export interface DependentSnippet {
    /** The dependent file (workspace-relative). */
    file: string;
    /** The dependent symbol name (function/class), or '(test)'. */
    symbol: string;
    relation: 'caller' | 'implementer' | 'sibling-impl' | 'test';
    /** Span-sliced source of the dependent symbol, byte-bounded. */
    snippet: string;
}

export interface FileDependents {
    filePath: string;
    dependents: DependentSnippet[];
}

/** Minimal store surface this module needs (keeps it decoupled + easily faked). */
export interface DependencyStoreLike {
    getWorking(): { files?: Record<string, any>; callGraph?: any } | undefined;
    getFileContent?(kind: 'working' | 'baseline', filePath: string): string | undefined;
}

const MAX_PER_FILE = 6;
const MAX_SNIPPET_CHARS = 700;
const TEST_RX = /(\.|_)(test|spec)\.|(^|\/)(tests?|spec|__tests__)\//i;

function fileContent(store: DependencyStoreLike, files: Record<string, any>, fp: string): string {
    return String(store.getFileContent?.('working', fp) ?? files[fp]?.content ?? '');
}

function symbols(files: Record<string, any>, fp: string): SymbolRecord[] {
    return (files[fp]?.symbols?.functions ?? []) as SymbolRecord[];
}

function snippetOf(content: string, sym: SymbolRecord | undefined): string {
    if (!content) return '';
    if (sym?.span && typeof sym.span.start === 'number' && typeof sym.span.end === 'number' && sym.span.end > sym.span.start) {
        const s = content.slice(sym.span.start, sym.span.end);
        return s.length > MAX_SNIPPET_CHARS ? s.slice(0, MAX_SNIPPET_CHARS) + '\n/* …truncated… */' : s;
    }
    // Fall back to signature, then file head.
    if (sym?.signature) return sym.signature.slice(0, MAX_SNIPPET_CHARS);
    return content.slice(0, MAX_SNIPPET_CHARS);
}

function splitKey(key: string): [string, string] {
    const i = key.lastIndexOf('::');
    return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 2)];
}

/**
 * Build the DEPENDENTS pack for a set of changed files. Returns one entry per
 * changed file that has at least one cross-file dependent (files with none are
 * omitted, so the caller can cheaply test `.length`).
 */
export function buildDependentsForFiles(
    store: DependencyStoreLike,
    changedFiles: string[],
    opts?: { maxPerFile?: number },
): FileDependents[] {
    const working = store.getWorking?.();
    if (!working) return [];
    const files = working.files ?? {};
    if (!Object.keys(files).length) return [];
    const maxPerFile = opts?.maxPerFile ?? MAX_PER_FILE;

    let cg: WorkspaceCallGraph | undefined;
    try {
        if (working.callGraph) cg = WorkspaceCallGraph.deserialize(working.callGraph);
    } catch {
        cg = undefined;
    }

    // Index: interface/base name -> classes (in any file) that implement/extend it.
    const implementersByName = new Map<string, Array<{ file: string; sym: SymbolRecord }>>();
    const add = (name: string, file: string, sym: SymbolRecord) => {
        if (!name) return;
        let arr = implementersByName.get(name);
        if (!arr) { arr = []; implementersByName.set(name, arr); }
        arr.push({ file, sym });
    };
    for (const [fp, rec] of Object.entries(files)) {
        for (const fn of (rec?.symbols?.functions ?? []) as SymbolRecord[]) {
            if (fn.kind !== 'class') continue;
            for (const iface of fn.implementsInterfaces ?? []) add(iface, fp, fn);
            if (fn.extendsClass) add(fn.extendsClass, fp, fn);
        }
    }

    const changedSet = new Set(changedFiles);
    const out: FileDependents[] = [];

    for (const cf of changedFiles) {
        const rec = files[cf];
        if (!rec) continue;
        const fns = symbols(files, cf);
        const seen = new Set<string>();
        const deps: DependentSnippet[] = [];

        const push = (d: DependentSnippet, dedupKey: string) => {
            if (seen.has(dedupKey) || !d.snippet) return;
            seen.add(dedupKey);
            deps.push(d);
        };

        // 1) Cross-file CALLERS — consumers that may assume the old contract.
        if (cg) {
            for (const fn of fns) {
                const node = cg.getNode(WorkspaceCallGraph.makeKey(cf, fn.name));
                if (!node) continue;
                for (const callerKey of node.calledBy) {
                    const [cfile, cname] = splitKey(callerKey);
                    if (!cfile || cfile === cf) continue; // same-file callers already visible
                    const csym = symbols(files, cfile).find((s) => s.name === cname);
                    push(
                        { file: cfile, symbol: cname || '(module)', relation: 'caller', snippet: snippetOf(fileContent(store, files, cfile), csym) },
                        'caller:' + callerKey,
                    );
                }
            }
        }

        // 2) IMPLEMENTERS of a type defined here + SIBLING implementers of an
        //    interface this file's class implements (the cal_10967 family).
        for (const fn of fns) {
            if (fn.kind !== 'class') continue;
            for (const impl of implementersByName.get(fn.name) ?? []) {
                if (impl.file === cf) continue;
                push(
                    { file: impl.file, symbol: impl.sym.name, relation: 'implementer', snippet: snippetOf(fileContent(store, files, impl.file), impl.sym) },
                    'impl:' + impl.file + '::' + impl.sym.name,
                );
            }
            for (const iface of fn.implementsInterfaces ?? []) {
                for (const sib of implementersByName.get(iface) ?? []) {
                    if (sib.file === cf || (sib.file === cf && sib.sym.name === fn.name)) continue;
                    if (sib.file === cf) continue;
                    push(
                        { file: sib.file, symbol: sib.sym.name, relation: 'sibling-impl', snippet: snippetOf(fileContent(store, files, sib.file), sib.sym) },
                        'sib:' + sib.file + '::' + sib.sym.name,
                    );
                }
            }
        }

        // 3) TEST references — a test/spec mentioning this file or its symbols.
        const base = (cf.split('/').pop() ?? cf).replace(/\.[^.]+$/, '');
        const symNames = fns.map((f) => f.name).filter((n) => n && n.length > 2);
        if (base.length > 1) {
            for (const [fp] of Object.entries(files)) {
                if (fp === cf || changedSet.has(fp) || !TEST_RX.test(fp)) continue;
                const content = fileContent(store, files, fp);
                if (!content) continue;
                if (content.includes(base) || symNames.some((n) => content.includes(n))) {
                    push(
                        { file: fp, symbol: '(test)', relation: 'test', snippet: content.length > MAX_SNIPPET_CHARS ? content.slice(0, MAX_SNIPPET_CHARS) + '\n/* …truncated… */' : content },
                        'test:' + fp,
                    );
                }
            }
        }

        if (deps.length) {
            // Order: implementers + siblings first (highest contract signal), then
            // callers, then tests — and cap so the pack stays cheap.
            const rank = (r: DependentSnippet['relation']) =>
                r === 'implementer' ? 0 : r === 'sibling-impl' ? 1 : r === 'caller' ? 2 : 3;
            deps.sort((a, b) => rank(a.relation) - rank(b.relation));
            out.push({ filePath: cf, dependents: deps.slice(0, maxPerFile) });
        }
    }
    return out;
}
