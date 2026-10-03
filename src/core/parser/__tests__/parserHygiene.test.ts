/**
 * parserHygiene.test.ts
 *
 * Issues 338-350: regression tests for the parser-hygiene rules added during
 * the L3/L5 sequence_no_flow cleanup. Each test pins one rule so a future
 * refactor can't accidentally re-introduce the false positive.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';
import { detectApis } from '../apiDetector';
import { collectTopLevelEntities } from '../symbolExtractor';

describe('parser hygiene — Kotlin annotation-site target (Issue 338)', () => {
    it('JAX-RS @(GET|POST|…) regex does NOT match Kotlin `@get:Rule`', () => {
        const source = `
class AppTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Before
    fun setUp() {}
}
`;
        const apis = detectFrameworkApis(source, 'app/src/androidTest/AppTest.kt', 'kotlin');
        // No GET/POST emitted from `@get:Rule` annotation site target.
        const httpApis = apis.filter(a => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(a.method));
        expect(httpApis).toEqual([]);
    });
});

describe('parser hygiene — Symfony class-level #[Route] (Issue 350)', () => {
    it('class-level #[Route(\'/blog\')] returns null (controller prefix, not endpoint)', () => {
        const source = `<?php
namespace App\\Controller;

#[Route('/blog')]
final class BlogController extends AbstractController
{
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    public function index() {}
}
`;
        const apis = detectFrameworkApis(source, 'src/Controller/BlogController.php', 'php');
        const blogPrefix = apis.find(a => a.route === '/blog');
        // The class-level prefix must NOT emit; only the method-level `/` does.
        expect(blogPrefix).toBeUndefined();
        expect(apis.some(a => a.route === '/')).toBe(true);
    });
});

describe('parser hygiene — block-comment guard (Issue 348)', () => {
    it('URL paths like `/proxy/*` do NOT self-mark as inside a block comment', () => {
        const source = `package main
func main() {
    app := fiber.New()
    app.All("/proxy/*", h)
    fiber.Get("/fiber-shorthand", h)
}
`;
        const apis = detectFrameworkApis(source, 'main.go', 'go');
        // Both routes must be detected — the `/proxy/*` regex match must
        // not falsely register as "inside /* ... */" and skip the next match.
        expect(apis.some(a => a.route === '/proxy/*')).toBe(true);
        expect(apis.some(a => a.route === '/fiber-shorthand')).toBe(true);
    });
});

describe('parser hygiene — Python triple-quoted docstring skip (Issue 350)', () => {
    it('routes inside `"""…"""` docstrings are not detected', () => {
        const source = `"""
Examples:
    url(r'^$', views.home, name='home')
    url(r'^$', Home.as_view(), name='home')
"""
from django.contrib import admin

urlpatterns = [
    url(r'^admin/', admin.site.urls),
    url(r'^api/$', api_view, name='api'),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        // Docstring matches must not appear:
        expect(apis.some(a => a.handlerName === 'home' || a.handlerName === 'Home')).toBe(false);
        // Real api_view route in `urlpatterns` should still be detected.
        expect(apis.some(a => a.route === '/api/' || a.handlerName === 'api_view')).toBe(true);
    });
});

describe('parser hygiene — JS keyword filter in findNearestFunctionName (Issue 348)', () => {
    it('`export class ArticleController` does NOT yield `class` as a handler', () => {
        const source = `
@Controller('articles')
export class ArticleController {
    @Get()
    findAll() { return []; }
}
`;
        const apis = detectFrameworkApis(source, 'src/article.controller.ts', 'typescript');
        // Even though the @Controller pattern can match, the keyword filter
        // must prevent `class` from leaking as a handler name.
        expect(apis.every(a => a.handlerName !== 'class')).toBe(true);
        expect(apis.every(a => a.handlerName !== 'function')).toBe(true);
    });
});

describe('parser hygiene — isInsideRustTestModule (Issue 350)', () => {
    it('routes inside `#[cfg(test)] mod tests { … }` are skipped', () => {
        const source = `
pub fn router() -> Router {
    Router::new().route("/api/users", get(real_handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_router() {
        async fn requires_foo() -> &'static str { "foo" }
        let _ = Router::new().route("/test/foo", get(requires_foo));
    }
}
`;
        const apis = detectFrameworkApis(source, 'src/router.rs', 'rust');
        expect(apis.some(a => a.route === '/api/users')).toBe(true);
        // Test-module route is suppressed.
        expect(apis.some(a => a.route === '/test/foo')).toBe(false);
    });
});

describe('parser hygiene — test-file rejection without override (Issue 348)', () => {
    it('RSpec `*_spec.rb` matches without explicit handler are dropped', () => {
        const source = `
describe 'app' do
  def cookie_route
    'noop'
  end
  it 'reads cookies' do
    get '/users' do
      'ok'
    end
  end
end
`;
        const apis = detectFrameworkApis(source, 'spec/cookies_spec.rb', 'ruby');
        // Sinatra `get '…' do` emits `anonymous@GET:/users` (override),
        // so the route is still listed — but `cookie_route` def must NOT
        // appear because it's not a real route handler.
        expect(apis.every(a => a.handlerName !== 'cookie_route')).toBe(true);
    });
});

describe('parser hygiene — apiDetector route shape guard (Issue 349)', () => {
    it('`storage.put(\'value\', value)` is NOT detected as PUT /value', () => {
        const code = `
class Counter {
    async increment() {
        let value = await this.storage.get('value') || 0;
        await this.storage.put('value', value + 1);
        return value;
    }
}
`;
        const apis = detectApis(code, 'durable-objects/counter.ts');
        expect(apis).toEqual([]);
    });

    it('`router.get(\'/users\', handler)` IS still detected (positive case)', () => {
        const code = `
const router = Router();
router.get('/users', listUsers);
router.post('/users', createUser);
`;
        const apis = detectApis(code, 'routes.js');
        expect(apis.some(a => a.method === 'GET' && a.route === '/users')).toBe(true);
        expect(apis.some(a => a.method === 'POST' && a.route === '/users')).toBe(true);
    });
});

describe('parser hygiene — opaque-external const handler skip (Issue 350)', () => {
    it('`app.all("*", remixHandler)` where remixHandler is a runtime conditional is skipped', () => {
        const code = `
import express from 'express';
const app = express();

async function run() {
    const remixHandler =
        process.env.NODE_ENV === "development"
            ? await createDevRequestHandler()
            : createRequestHandler({});

    app.all("*", remixHandler);
}
`;
        const apis = detectApis(code, 'server.ts');
        // remixHandler is a runtime conditional — no flow graph can be
        // produced; the api must not be emitted.
        expect(apis).toEqual([]);
    });

    it('`app.get("/x", namedFn)` with a normal const-bound function is still emitted', () => {
        const code = `
const app = express();

const usersHandler = (req, res) => res.json([]);

app.get('/users', usersHandler);
`;
        const apis = detectApis(code, 'server.ts');
        expect(apis.length).toBe(1);
        expect(apis[0].handlerName).toBe('usersHandler');
    });
});

describe('parser hygiene — Django `.urls` accessor is not a handler (Issue 350)', () => {
    it('`url(r\'^admin/\', admin.site.urls)` is skipped (URLConf aggregator)', () => {
        const source = `
from django.contrib import admin
from django.conf.urls import url

urlpatterns = [
    url(r'^admin/', admin.site.urls),
    url(r'^api/$', api_view),
]
`;
        const apis = detectFrameworkApis(source, 'urls.py', 'python');
        expect(apis.every(a => a.handlerName !== 'urls' && a.handlerName !== 'site')).toBe(true);
        // The real api_view route must still be detected.
        expect(apis.some(a => a.handlerName === 'api_view')).toBe(true);
    });
});

describe('parser hygiene — tRPC `name: publicProcedure.query(arrow)` extraction (Issue 350)', () => {
    it('symbolExtractor picks up tRPC procedures as flow-eligible entities', () => {
        // This is end-to-end via collectTopLevelEntities (imported from symbolExtractor).
        // dynamic import to avoid TS module-resolution ambiguity in tests

        const code = `
import { initTRPC } from '@trpc/server';
const t = initTRPC.create();
const publicProcedure = t.procedure;

export const appRouter = t.router({
    healthcheck: publicProcedure.query(() => ({ ok: true })),
    listUsers: publicProcedure.query(({ input }) => {
        if (!input) return [];
        return ['alice', 'bob'];
    }),
    createUser: publicProcedure.mutation(({ input }) => input),
});
`;
        const r = collectTopLevelEntities(code, 'src/server/router.ts');
        const fnNames = new Set([...r.funcs.keys()]);
        expect(fnNames.has('healthcheck')).toBe(true);
        expect(fnNames.has('listUsers')).toBe(true);
        expect(fnNames.has('createUser')).toBe(true);
    });
});

describe('parser hygiene — named FunctionExpression at any depth (Issue 350)', () => {
    it('symbolExtractor picks up `app.all("*", function getReplayResponse(...))`', () => {
        // dynamic import to avoid TS module-resolution ambiguity in tests

        const code = `
import express from 'express';

async function run() {
    const app = express();
    app.all("*", function getReplayResponse(req, res, next) {
        if (req.path === '/replay') {
            return res.json({ ok: true });
        }
        next();
    });
}

run();
`;
        const r = collectTopLevelEntities(code, 'server.ts');
        const fnNames = new Set([...r.funcs.keys()]);
        // Named function expression nested inside `run()` is captured.
        expect(fnNames.has('getReplayResponse')).toBe(true);
    });
});
