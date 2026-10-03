/**
 * testPathFilter.ts — BUG-EXP-12 (2026-07-12).
 *
 * Route-like patterns (`router.register`, `path(...)`, `@RestController`, …) that
 * appear inside TEST files are test scaffolding, not production entry points, yet
 * the framework detector picked them up and inflated the L1 "N HTTP routes
 * exposed" headline (py-drf: "118 routes" of which ~106 were in `tests/`;
 * java-spring-kafka: 250 test routes). The feature clusterer already sinks test
 * files into no-entry-point buckets, so L1 and L2a contradicted each other.
 *
 * This predicate lets the snapshot builders SKIP entry-point detection for test
 * files, so L1, L2a and L2b all agree on the real (production) entry points.
 * Applied at the call site (not inside the detector) so the detector's own unit
 * tests — which legitimately pass test-flavoured file paths — are unaffected.
 */

const TEST_PATH_RE = new RegExp(
    [
        '(^|/)(tests?|__tests__|__mocks__|specs?|testing)(/)', // a test/spec/mock DIRECTORY at any depth
        '(^|/)src/test/',                                       // Java/Kotlin/Maven/Gradle test source root
        '[._-](test|spec)\\.[a-z0-9]+$',                        // foo.test.ts, foo-spec.js, foo_spec.rb
        '(^|/)test_[^/]+\\.py$',                                // Python `test_*.py`
        '_test\\.(py|go|rb|java|kt|kts|rs|php|cs)$',            // Go/Python/Ruby/… `*_test.*`
        'Test\\.(java|kt|kts|cs)$',                             // JUnit/Kotlin/C# `FooTest.java`
        'Tests\\.(java|kt|kts|cs)$',                            // `FooTests.cs`
    ].join('|'),
    'i',
);

/** True if `filePath` is a test / spec / mock file (its entry points are scaffolding). */
export function isTestPath(filePath: string): boolean {
    return TEST_PATH_RE.test(filePath);
}

/**
 * TICKET-DETECT-1 — VENDORED / bundled third-party code that lives inside the
 * repo tree (not `node_modules`, so the test filter above doesn't catch it) but
 * is NOT the app's own source. The Next.js framework repo vendors its deps under
 * `packages/next/src/compiled/**` — 364 EVENT_LISTENER/EMIT records (edge-runtime,
 * stream-http, ws, crypto-browserify, …) leaked into the API surface from there.
 * Like `isTestPath`, this lets the snapshot builders SKIP entry-point detection
 * for such files so vendored library internals don't inflate the counts.
 */
const VENDORED_PATH_RE = new RegExp(
    [
        '(^|/)(vendor|compiled|third[_-]party|bower_components|jspm_packages)(/)', // vendored/bundled dep dirs
        '\\.min\\.(js|css|mjs|cjs)$',                                             // minified bundles
    ].join('|'),
    'i',
);

/** True if `filePath` is vendored / bundled third-party code (not app source). */
export function isVendoredPath(filePath: string): boolean {
    return VENDORED_PATH_RE.test(filePath);
}
