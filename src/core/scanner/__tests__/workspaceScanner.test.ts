import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceScanner } from '../workspaceScanner';

describe('WorkspaceScanner', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createFile(relativePath: string, content: string = 'const x = 1;') {
        const fullPath = path.join(tmpDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
        return fullPath;
    }

    it('should find supported files in a directory', () => {
        createFile('src/a.js');
        createFile('src/b.js');
        createFile('src/c.txt'); // not supported

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(2);
        expect(results.map((r) => r.relativePath).sort()).toEqual(['src/a.js', 'src/b.js']);
    });

    it('should ignore node_modules by default', () => {
        createFile('src/app.js');
        createFile('node_modules/lib/index.js');

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(1);
        expect(results[0].relativePath).toBe('src/app.js');
    });

    it('should ignore dist directory', () => {
        createFile('src/app.js');
        createFile('dist/bundle.js');

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(1);
        expect(results[0].relativePath).toBe('src/app.js');
    });

    it('should compute SHA-256 hash of file content', () => {
        const content = 'const x = 42;';
        const hash = WorkspaceScanner.hashContent(content);

        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        // Same content should give same hash
        expect(WorkspaceScanner.hashContent(content)).toBe(hash);
        // Different content should give different hash
        expect(WorkspaceScanner.hashContent('const x = 43;')).not.toBe(hash);
    });

    it('should scan all files without truncation', () => {
        for (let i = 0; i < 10; i++) {
            createFile(`file${i}.js`);
        }

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        // No truncation — all files returned
        expect(results).toHaveLength(10);
        expect((results as any).__truncated).toBe(false);
    });

    it('should include hash and mtime in scan results', () => {
        createFile('app.js', 'const hello = "world";');

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(1);
        expect(results[0].hash).toMatch(/^[a-f0-9]{64}$/);
        expect(results[0].mtime).toBeGreaterThan(0);
    });

    it('shouldIgnore should match glob patterns', () => {
        const scanner = new WorkspaceScanner(['**/node_modules/**', '**/dist/**']);

        expect(scanner.shouldIgnore('node_modules/lib/x.js')).toBe(true);
        expect(scanner.shouldIgnore('dist/bundle.js')).toBe(true);
        expect(scanner.shouldIgnore('src/app.js')).toBe(false);
    });

    it('should handle empty directories', () => {
        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(0);
    });

    it('should scan nested directories', () => {
        createFile('src/api/routes/users.js');
        createFile('src/api/routes/orders.js');
        createFile('src/utils/helpers.js');

        const scanner = new WorkspaceScanner();
        const results = scanner.scan(tmpDir);

        expect(results).toHaveLength(3);
    });

    // Comprehensive language/framework dependency-directory exclusion. The
    // default ignore list should keep L4 / L5 from being built for any third-
    // party / build / cache directory. Each pattern below corresponds to a
    // dependency manager or framework convention.
    describe('default ignore patterns — by language / framework', () => {
        it('excludes JS / TS dependency + cache + build dirs', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('node_modules/lib/x.js')).toBe(true);
            expect(s.shouldIgnore('bower_components/foo/index.js')).toBe(true);
            expect(s.shouldIgnore('.next/server/pages/api.js')).toBe(true);
            expect(s.shouldIgnore('.nuxt/dist/server.mjs')).toBe(true);
            expect(s.shouldIgnore('.svelte-kit/output/client.js')).toBe(true);
            expect(s.shouldIgnore('.expo/web/cache.json')).toBe(true);
            expect(s.shouldIgnore('.turbo/cache.json')).toBe(true);
            expect(s.shouldIgnore('.parcel-cache/lock')).toBe(true);
            expect(s.shouldIgnore('dist/index.js')).toBe(true);
            // `out/` is intentionally not excluded — see comment in DEFAULT_IGNORE.
            expect(s.shouldIgnore('out/index.html')).toBe(false);
        });

        it('excludes Python venv + cache dirs', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('__pycache__/foo.pyc')).toBe(true);
            expect(s.shouldIgnore('.venv/lib/python3/site-packages/x.py')).toBe(true);
            expect(s.shouldIgnore('venv/bin/activate')).toBe(true);
            expect(s.shouldIgnore('.pytest_cache/v/cache/lastfailed')).toBe(true);
            expect(s.shouldIgnore('.mypy_cache/3.11/foo.json')).toBe(true);
            expect(s.shouldIgnore('mylib.egg-info/PKG-INFO')).toBe(true);
            // `env/` is intentionally NOT excluded — see comment in DEFAULT_IGNORE.
            expect(s.shouldIgnore('pkg/env/env.go')).toBe(false);
        });

        it('excludes Java / Kotlin / Gradle / Maven build dirs', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('target/classes/Foo.class')).toBe(true);
            expect(s.shouldIgnore('.gradle/caches/foo.bin')).toBe(true);
            expect(s.shouldIgnore('app/build/intermediates/classes/Foo.class')).toBe(true);
            expect(s.shouldIgnore('.idea/workspace.xml')).toBe(true);
        });

        it('excludes Go / PHP / Ruby vendored deps', () => {
            const s = new WorkspaceScanner();
            // Go modules vendor dir
            expect(s.shouldIgnore('vendor/github.com/foo/bar/go.go')).toBe(true);
            // PHP Composer
            expect(s.shouldIgnore('vendor/symfony/console/Application.php')).toBe(true);
            // Ruby Bundler
            expect(s.shouldIgnore('.bundle/config')).toBe(true);
        });

        it('excludes .NET build dirs (configuration-scoped)', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('bin/Debug/net6.0/MyApp.dll')).toBe(true);
            expect(s.shouldIgnore('bin/Release/net6.0/MyApp.dll')).toBe(true);
            expect(s.shouldIgnore('bin/x64/Debug/MyApp.dll')).toBe(true);
            expect(s.shouldIgnore('obj/Debug/foo.dll')).toBe(true);
            expect(s.shouldIgnore('obj/project.assets.json')).toBe(true);
            // Bare `bin/` MUST be allowed — celery's CLI source is at
            // `celery/bin/*.py` and Express scaffolds at `bin/createNodejsApp.js`.
            expect(s.shouldIgnore('bin/createNodejsApp.js')).toBe(false);
            expect(s.shouldIgnore('celery/bin/worker.py')).toBe(false);
            // Bare `obj/` is also allowed (only the .NET-specific subpaths fire).
            expect(s.shouldIgnore('obj/foo.txt')).toBe(false);
        });

        it('excludes iOS / Swift dependency + build dirs', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('Pods/AFNetworking/AFNetworking.m')).toBe(true);
            expect(s.shouldIgnore('.build/x86_64-apple-macosx/release/MyApp')).toBe(true);
            expect(s.shouldIgnore('DerivedData/MyApp/Build/Products/Debug/MyApp')).toBe(true);
            expect(s.shouldIgnore('.swiftpm/configuration/registries.json')).toBe(true);
            expect(s.shouldIgnore('MyApp.xcodeproj/project.pbxproj')).toBe(true);
            expect(s.shouldIgnore('MyApp.xcworkspace/contents.xcworkspacedata')).toBe(true);
        });

        it('excludes Flutter / Dart artefacts', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('.dart_tool/package_config.json')).toBe(true);
        });

        it('excludes coverage + IaC + serverless caches', () => {
            const s = new WorkspaceScanner();
            expect(s.shouldIgnore('coverage/lcov.info')).toBe(true);
            expect(s.shouldIgnore('htmlcov/index.html')).toBe(true);
            expect(s.shouldIgnore('.terraform/providers/foo')).toBe(true);
            expect(s.shouldIgnore('.serverless/cloudformation.json')).toBe(true);
        });

        it('does NOT exclude legitimate source dirs (monorepo packages/, src/, app/, bin/, env/, log/)', () => {
            const s = new WorkspaceScanner();
            // ts-apollo, ts-react-native/with-yarn-workspaces, Lerna repos all
            // use `packages/` as the source root.
            expect(s.shouldIgnore('packages/cache-control-types/src/index.ts')).toBe(false);
            expect(s.shouldIgnore('src/app.ts')).toBe(false);
            expect(s.shouldIgnore('app/models/user.ts')).toBe(false);
            expect(s.shouldIgnore('backend/app/api/routes/items.py')).toBe(false);
            // Several real projects ship source under `bin/` (Express scaffold,
            // celery CLI), `env/` (Go env modules), and `log/` (Rails logging).
            expect(s.shouldIgnore('bin/server.js')).toBe(false);
            expect(s.shouldIgnore('celery/bin/celery.py')).toBe(false);
            expect(s.shouldIgnore('bootstrap/pkg/env/env.go')).toBe(false);
            expect(s.shouldIgnore('log/dev.log')).toBe(false);
        });

        it('user patterns extend the defaults (do not replace)', () => {
            const s = new WorkspaceScanner(['**/my-custom-dir/**']);
            // User's pattern works...
            expect(s.shouldIgnore('my-custom-dir/foo.ts')).toBe(true);
            // ...AND defaults still apply.
            expect(s.shouldIgnore('node_modules/x.js')).toBe(true);
            expect(s.shouldIgnore('__pycache__/x.pyc')).toBe(true);
        });

        it('replaceDefaults=true opts out of the defaults entirely', () => {
            const s = new WorkspaceScanner(['**/only-this/**'], 2000, true);
            expect(s.shouldIgnore('only-this/foo.ts')).toBe(true);
            // Defaults are now off, so node_modules WOULD scan (caller's
            // responsibility) — confirms the opt-out worked.
            expect(s.shouldIgnore('node_modules/x.js')).toBe(false);
        });
    });
});
