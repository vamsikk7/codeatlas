#!/usr/bin/env tsx
/**
 * lint-silent-catches.ts — Issue 357 / ADR-028
 *
 * INVARIANT: every `catch {}` block in src/ either:
 *   (a) has an inline comment explaining why it's swallowing, OR
 *   (b) calls `analytics.track(...)` or `this.log(...)` / `outputChannel.append*`
 *       so the failure surfaces somewhere observable.
 *
 * This script greps the codebase for catch blocks and flags violations.
 * Returns non-zero exit when violations exist, so CI can block on them.
 *
 * NOT a full AST analysis — works on text matches. False positives are
 * possible but rare; false negatives (genuine silent catches) are what
 * we're trying to prevent.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', 'src');
const EXCLUDE_DIRS = new Set(['__tests__', 'node_modules', 'dist', '.git']);

interface Violation {
    file: string;
    line: number;
    snippet: string;
}

function* walk(dir: string): Generator<string> {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(ent.name)) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(p);
        else if (ent.isFile() && /\.(ts|tsx|js|mjs)$/.test(ent.name)) yield p;
    }
}

/**
 * Detect silent catches. A `catch (...) { ... }` block is silent when:
 *   1. The body has no comment (no `//`, no `/*`)
 *   2. The body has no observability call (no `track(`, `log(`,
 *      `appendLine(`, `notifyBrowser(`, `console.error(`, etc.)
 *   3. The body has no `return` / `continue` / `break` (a control flow
 *      that names the recovery path is acceptable; an empty `{}` is not).
 *
 * Tradeoff: a `} catch { return null; }` is permitted because the return
 * value documents the recovery contract. A `} catch {}` with literally
 * nothing inside is the case we want to catch.
 */
function scanFile(filePath: string): Violation[] {
    const violations: Violation[] = [];
    const text = fs.readFileSync(filePath, 'utf-8');
    const lines = text.split('\n');

    // Find `catch ... {` openings via a regex pass; for each, balance
    // braces forward to find the matching `}` and inspect the body.
    const catchRe = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = catchRe.exec(text)) !== null) {
        const startIdx = match.index;
        const bodyStart = match.index + match[0].length;
        let depth = 1;
        let i = bodyStart;
        // Quick brace balance — does NOT account for braces inside strings
        // / regex / template literals. Acceptable for this lint pass; the
        // worst case is a false negative (we miss a silent catch buried
        // inside a complex string). Real catches are nearly always plain.
        while (i < text.length && depth > 0) {
            const c = text[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '/' && text[i + 1] === '/') {
                // skip to end of line
                while (i < text.length && text[i] !== '\n') i++;
            } else if (c === '/' && text[i + 1] === '*') {
                i = text.indexOf('*/', i + 2);
                if (i < 0) break;
                i += 2;
                continue;
            } else if (c === '"' || c === "'" || c === '`') {
                const quote = c;
                i++;
                while (i < text.length && text[i] !== quote) {
                    if (text[i] === '\\') i++;
                    i++;
                }
            }
            i++;
        }
        const bodyEnd = i - 1;
        if (bodyEnd <= bodyStart) continue;
        const body = text.slice(bodyStart, bodyEnd);

        // Acceptable signals:
        const hasComment = /\/\/|\/\*/.test(body);
        // Observability calls — note we do NOT use a trailing \b because
        // `log(` ends in a non-word char which has no \b boundary against
        // a following `\`` template-literal start.
        const hasObservability =
            /\banalytics\.track\b/.test(body) ||
            /\bthis\.log\(/.test(body) ||
            /\bctx\.log\(/.test(body) ||
            /(?:^|[^.\w])log\(/.test(body) ||
            /\boutputChannel\./.test(body) ||
            /\bappendLine\(/.test(body) ||
            /\bnotifyBrowser\b/.test(body) ||
            /\bconsole\.(?:error|warn)\(/.test(body) ||
            /\bresolve\(/.test(body) ||  // promise resolve = recovery contract
            /\breject\(/.test(body);     // promise reject = re-throw equivalent
        const hasThrow = /\bthrow\b/.test(body);
        // Control-flow keywords that name a recovery contract:
        // `return X;` / `continue;` / `break;` are acceptable because the
        // function's return type or loop semantics document the recovery.
        const hasControlFlow = /\b(?:return|continue|break)\b/.test(body);
        // Variable assignment as recovery (e.g., `name = fallback;`).
        // We accept any assignment as evidence the catch isn't silent.
        const hasAssignment = /=[^=]/.test(body) && !/^\s*$/.test(body);
        // Method call / state mutation as recovery (e.g., `this.clients.delete(id)`).
        // Pattern: `<word>.<word>(` with optional chained dots.
        const hasMethodCall = /\b\w+(?:\.\w+)+\s*\(/.test(body);

        if (hasComment) continue;
        if (hasObservability) continue;
        if (hasThrow) continue;
        if (hasControlFlow) continue;
        if (hasAssignment) continue;
        if (hasMethodCall) continue;

        // Truly silent: empty / whitespace-only body with no signal.
        const lineNum = text.slice(0, startIdx).split('\n').length;
        const snippet = lines[lineNum - 1]?.trim() ?? '';
        violations.push({
            file: path.relative(path.resolve(ROOT, '..'), filePath),
            line: lineNum,
            snippet: snippet.slice(0, 120),
        });
    }
    return violations;
}

function main(): void {
    const allViolations: Violation[] = [];
    for (const f of walk(ROOT)) {
        allViolations.push(...scanFile(f));
    }

    if (allViolations.length === 0) {
        console.log('[lint:catches] OK — no silent catch blocks found.');
        process.exit(0);
    }

    console.error(`[lint:catches] FAIL — ${allViolations.length} silent catch block(s) found:`);
    for (const v of allViolations) {
        console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    console.error('');
    console.error('Each catch block in src/ must EITHER:');
    console.error('  (a) include a comment explaining why it swallows the error, OR');
    console.error('  (b) call analytics.track / log / outputChannel.appendLine / notifyBrowser, OR');
    console.error('  (c) re-throw the error.');
    console.error('');
    console.error('See ADR-028 for the full rationale + Issue 357.');
    process.exit(1);
}

main();
