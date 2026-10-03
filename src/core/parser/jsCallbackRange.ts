/**
 * jsCallbackRange.ts
 *
 * Locates the source range of an anonymous route handler callback in JS/TS
 * source via regex + brace counting. Used as a fallback when tree-sitter
 * cannot parse the file (most commonly: TSX files with JSX in the handler
 * body — `tree-sitter-typescript` does not handle JSX).
 *
 * The returned text is the raw callback source (e.g. `(c) => { ... }`) which
 * can be wrapped as `const __handler = ${text}` and parsed by Babel.
 */

/**
 * Find an anonymous route handler callback's source range.
 *
 * @param code     Full file source.
 * @param method   HTTP method (case-insensitive). Matched as `.<method>(`
 *                 against the property of the call (so `app.get`, `router.post`,
 *                 `fastify.delete` etc. all match).
 * @param route    Route string. Matched as the first quoted argument.
 * @returns        `{ text, startIndex, endIndex }` of the callback expression
 *                 (`(req, res) => {...}` or `function (req, res) {...}`),
 *                 or `null` if no match.
 */
export function findJsCallbackRange(
    code: string,
    method: string,
    route: string,
): { text: string; startIndex: number; endIndex: number } | null {
    // Issue 289: strip line and block comments so a commented-out route
    // pattern (e.g. `// app.get('/users', () => {})`) can't match.
    const stripped = stripCommentsKeepIndices(code);

    const verb = method.toLowerCase();
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match: `.<verb>('<route>'` or `.<verb>("<route>"` or with a backtick.
    // We look for the call site, then walk the args list to find the
    // arrow_function / function_expression callback (last such arg, since
    // earlier args may be middleware).
    const pattern = new RegExp(
        `\\.\\s*${verb}\\s*\\(\\s*['"\`]${escapedRoute}['"\`]`,
        'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped)) !== null) {
        // Position right after the route literal — start scanning args.
        const argsStart = m.index + m[0].length;
        const argsEnd = matchArgsEnd(code, argsStart);
        if (argsEnd < 0) continue;
        // Walk the args region (using the original `code` so JSX, strings, and
        // template literals all reach the callback finder unmodified).
        const cb = findLastCallbackInRange(code, argsStart, argsEnd);
        if (cb) return cb;
    }

    // Issue 414: template-literal parameterized route fallback. For
    // `for (let i=1; i<=25; i++) router.get(\`/random/${i}\`, arrow)` the
    // emitted parameterized route `/random/:i` won't match a string literal
    // — the actual source uses interpolation. If the route contains an
    // Express-style `:<name>` parameter, search for the corresponding
    // template literal form `\`/random/${`.
    if (/\/:\w+/.test(route)) {
        // Build a permissive pattern: replace `/:<name>` segments with `/${`
        // (start of an interpolation), preserve literal `/` boundaries.
        const tplShape = route.split('/').map(seg => {
            if (/^:\w+$/.test(seg)) return '\\$\\{';
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('/');
        const tplPattern = new RegExp(
            `\\.\\s*${verb}\\s*\\(\\s*\`${tplShape}`,
            'gi',
        );
        let mt: RegExpExecArray | null;
        while ((mt = tplPattern.exec(stripped)) !== null) {
            const callOpen = stripped.lastIndexOf('(', mt.index + mt[0].length);
            if (callOpen < 0) continue;
            const argsEnd = matchArgsEnd(code, callOpen + 1);
            if (argsEnd < 0) continue;
            const cb = findLastCallbackInRange(code, callOpen + 1, argsEnd);
            if (cb) return cb;
        }
    }

    return null;
}

// Replace `//...` and `/*...*/` comment characters with spaces while
// preserving every other character's index. The pattern matcher then sees a
// blank where a commented `app.get(...)` would have been, eliminating the
// false-positive without losing alignment with the original source ranges
// used by `matchArgsEnd` / `findLastCallbackInRange`.
function stripCommentsKeepIndices(code: string): string {
    const out: string[] = new Array(code.length);
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipString(code, i);
            for (let j = i; j < end && j < code.length; j++) out[j] = code[j];
            i = end;
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            const eol = code.indexOf('\n', i);
            const stop = eol < 0 ? code.length : eol;
            for (let j = i; j < stop; j++) out[j] = ' ';
            i = stop;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            const close = code.indexOf('*/', i + 2);
            const stop = close < 0 ? code.length : close + 2;
            for (let j = i; j < stop; j++) out[j] = code[j] === '\n' ? '\n' : ' ';
            i = stop;
            continue;
        }
        out[i] = ch;
        i++;
    }
    return out.join('');
}

// Scan from a position just past `(` (opening of arg list) and return the
// index of the matching `)`. Caller has already consumed the route literal,
// so we're inside the arg list with paren-depth 1.
function matchArgsEnd(code: string, fromIndex: number): number {
    let depth = 1;
    let i = fromIndex;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            // Skip string literal
            i = skipString(code, i);
            continue;
        } else if (ch === '/' && code[i + 1] === '/') {
            i = code.indexOf('\n', i);
            if (i < 0) return -1;
        } else if (ch === '/' && code[i + 1] === '*') {
            const end = code.indexOf('*/', i + 2);
            if (end < 0) return -1;
            i = end + 2;
            continue;
        }
        i++;
    }
    return -1;
}

function skipString(code: string, from: number): number {
    const quote = code[from];
    let i = from + 1;
    while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) return i + 1;
        i++;
    }
    return code.length;
}

// Find the last arrow_function or function_expression callback within the
// given source range. This is a heuristic scanner — we look for `=>` or
// `function` tokens at brace-depth 0 within the range.
function findLastCallbackInRange(
    code: string,
    rangeStart: number,
    rangeEnd: number,
): { text: string; startIndex: number; endIndex: number } | null {
    // Walk the range and collect candidate start positions for arrow/function.
    const arrowStarts: number[] = [];
    const fnStarts: number[] = [];
    let i = rangeStart;
    let depth = 0;
    while (i < rangeEnd) {
        const ch = code[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString(code, i);
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            i = code.indexOf('\n', i);
            if (i < 0 || i > rangeEnd) break;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            const end = code.indexOf('*/', i + 2);
            if (end < 0 || end > rangeEnd) break;
            i = end + 2;
            continue;
        }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        if (depth === 0) {
            if (ch === '=' && code[i + 1] === '>') {
                // Find start of the arrow's params: walk back to matching `(` or single ident.
                arrowStarts.push(findArrowParamStart(code, i, rangeStart));
            } else if (
                ch === 'f' &&
                code.substr(i, 8) === 'function' &&
                /[\s(*]/.test(code[i + 8] ?? '') &&
                (i === 0 || /[\s,(=:?]/.test(code[i - 1]))
            ) {
                fnStarts.push(i);
            }
        }
        i++;
    }
    // Take the last arrow if any, otherwise last fn.
    const candidates: Array<{ kind: 'arrow' | 'fn'; start: number }> = [
        ...arrowStarts.map(s => ({ kind: 'arrow' as const, start: s })),
        ...fnStarts.map(s => ({ kind: 'fn' as const, start: s })),
    ].sort((a, b) => a.start - b.start);
    if (candidates.length === 0) return null;
    const last = candidates[candidates.length - 1];

    // Find end: walk forward, balanced through the body block or single expression.
    const end = findExprEnd(code, last.start, rangeEnd);
    if (end < 0) return null;
    return {
        text: code.slice(last.start, end),
        startIndex: last.start,
        endIndex: end,
    };
}

function findArrowParamStart(code: string, arrowIdx: number, lowerBound: number): number {
    // Walk back from `=` skipping whitespace, then either match `)` back to `(`
    // or skip a single identifier.
    let i = arrowIdx - 1;
    while (i > lowerBound && /\s/.test(code[i])) i--;
    if (code[i] === ')') {
        let depth = 1;
        i--;
        while (i > lowerBound) {
            if (code[i] === ')') depth++;
            else if (code[i] === '(') {
                depth--;
                if (depth === 0) break;
            }
            i--;
        }
        // Check for `async ` before the `(`
        let j = i - 1;
        while (j > lowerBound && /\s/.test(code[j])) j--;
        if (j >= lowerBound + 4 && code.substr(j - 4, 5) === 'async') return j - 4;
        return i;
    }
    // Single identifier or destructuring: walk back past identifier chars.
    while (i > lowerBound && /[$\w]/.test(code[i])) i--;
    return i + 1;
}

function findExprEnd(code: string, start: number, rangeEnd: number): number {
    let i = start;
    let depth = 0;
    let inExpr = false;
    while (i < rangeEnd) {
        const ch = code[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString(code, i);
            inExpr = true;
            continue;
        }
        if (ch === '/' && code[i + 1] === '/') {
            i = code.indexOf('\n', i);
            if (i < 0 || i > rangeEnd) return rangeEnd;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            const end = code.indexOf('*/', i + 2);
            if (end < 0 || end > rangeEnd) return rangeEnd;
            i = end + 2;
            continue;
        }
        if (ch === '(' || ch === '{' || ch === '[') { depth++; inExpr = true; }
        else if (ch === ')' || ch === '}' || ch === ']') {
            depth--;
            if (depth < 0) return i; // hit the enclosing `)` of the args list
            if (depth === 0) {
                inExpr = true;
                // After a closing `}` for an arrow body, we're done.
                if (ch === '}') return i + 1;
            }
        } else if (depth === 0 && inExpr && (ch === ',' || ch === ';')) {
            return i;
        }
        i++;
    }
    return rangeEnd;
}
