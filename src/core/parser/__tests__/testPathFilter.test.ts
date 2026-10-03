/**
 * testPathFilter.test.ts — BUG-EXP-12.
 */
import { describe, it, expect } from 'vitest';
import { isTestPath, isVendoredPath } from '../testPathFilter';

describe('TICKET-DETECT-1 — isVendoredPath', () => {
    it('matches vendored / bundled in-tree code', () => {
        for (const p of [
            'packages/next/src/compiled/edge-runtime/index.js',
            'packages/next/src/compiled/ws/index.js',
            'vendor/github.com/foo/bar.go',
            'app/vendor/bundle/x.rb',
            'third_party/lib/x.js', 'third-party/lib/x.js',
            'public/js/app.min.js', 'assets/style.min.css',
        ]) {
            expect(isVendoredPath(p), `${p} should be vendored`).toBe(true);
        }
    });
    it('does NOT match real app source', () => {
        for (const p of [
            'src/app/article/article.controller.ts', 'pages/index.tsx',
            'lib/compiledHelpers.ts',   // "compiled" as a substring, not a dir
            'src/vendors.ts',           // "vendor" as a substring, not a dir
            'app.js', 'src/min.ts',
        ]) {
            expect(isVendoredPath(p), `${p} should NOT be vendored`).toBe(false);
        }
    });
});

describe('BUG-EXP-12 — isTestPath', () => {
    it('classifies test/spec/mock paths as tests', () => {
        for (const p of [
            'tests/test_openapi.py',          // py-drf
            'rest_framework/tests/test_routers.py',
            'src/test/java/com/example/OrderConsumerTest.java', // spring-kafka
            'app/foo/__tests__/handler.ts',
            'spec/models/user_spec.rb',        // ruby
            'internal/handler_test.go',        // go
            'src/api.test.ts',                 // js/ts
            'src/api-spec.js',
            'com/example/UserServiceTest.java',
            'Foo.Tests.cs',
            'app/tests/routers.py',
        ]) {
            expect(isTestPath(p), `${p} should be a test path`).toBe(true);
        }
    });

    it('does NOT classify production source as tests', () => {
        for (const p of [
            'conduit/apps/articles/views.py',
            'app/controllers/users_controller.rb',
            'src/routes/items.py',
            'src/main.tsx',
            'internal/handler.go',
            'src/main/java/com/example/OrderController.java', // main, not test
            'backend/app/api/routes/items.py',
            'contest/entry.py',                // 'test' as a substring, not a dir/file marker
            'src/latest/index.ts',
        ]) {
            expect(isTestPath(p), `${p} should NOT be a test path`).toBe(false);
        }
    });
});
