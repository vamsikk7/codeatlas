/**
 * frameworkDetectorPerf.test.ts — #899
 *
 * The comment/template-literal suppression predicates used to scan the source
 * from offset 0 PER MATCH (O(matches × fileLen)) and allocate idx-sized strings
 * for the `"""` docstring check. On a large file with hundreds of suppressed
 * matches this was the swallowed `[Rebuild] Failed` / cascade-skip class.
 *
 * The fix precomputes the toggle positions once (linear) and binary-searches per
 * match. This test pins both halves of the contract:
 *  1. CORRECTNESS — matches inside a backtick template literal are still
 *     suppressed; real routes outside it are still found.
 *  2. PERFORMANCE — a 2 MB file with 500 backtick-suppressed matches completes
 *     well under a generous bound (the old O(n²) path blew past it).
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

describe('#899 — suppression scanning is linear, not quadratic', () => {
    it('2MB file with 500 backtick-suppressed app.get() matches: correct + fast', () => {
        // 500 `app.get(...)` lines INSIDE one big template literal → all suppressed.
        const suppressed = Array.from({ length: 500 }, (_, i) => `  app.get("/tmpl${i}", h);`).join('\n');
        // Pad the template body to ~2 MB so a per-match from-offset-0 scan is costly.
        const pad = '// '.padEnd(4000, 'x') + '\n';
        const bigTemplate = 'const docs = `\n' + suppressed + '\n' + pad.repeat(500) + '`;\n';
        // Two REAL routes OUTSIDE the template — must still be detected.
        const realRoutes = `\napp.get("/real-a", h);\napp.post("/real-b", h);\n`;
        const source = bigTemplate + realRoutes;
        expect(source.length).toBeGreaterThan(2_000_000);

        const t0 = Date.now();
        const apis = detectFrameworkApis(source, 'src/server.ts', 'typescript');
        const elapsed = Date.now() - t0;

        // Correctness: none of the 500 template-embedded routes leak through.
        expect(apis.find((a) => /\/tmpl\d+/.test(a.route))).toBeUndefined();
        // The two real routes outside the template ARE found.
        expect(apis.find((a) => a.route === '/real-a' && a.method === 'GET')).toBeDefined();
        expect(apis.find((a) => a.route === '/real-b' && a.method === 'POST')).toBeDefined();

        // Performance: generous bound. The old O(matches × fileLen) path on
        // 2 MB × 500 matches takes many seconds; the linear index is ~tens of ms.
        expect(elapsed, `detectFrameworkApis took ${elapsed}ms`).toBeLessThan(3000);
    });
});
