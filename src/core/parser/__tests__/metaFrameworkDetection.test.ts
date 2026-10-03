/**
 * metaFrameworkDetection.test.ts
 *
 * Tests for Next.js, Nuxt, Remix, SvelteKit, and tRPC API route detection.
 */

import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

// ─── Next.js App Router ──────────────────────────────────────────────────────

describe('Next.js App Router', () => {
    it('detects export async function GET', () => {
        const source = `export async function GET(request: Request) { return Response.json({}); }`;
        const apis = detectFrameworkApis(source, 'app/api/users/route.ts', 'typescript');
        const get = apis.find(a => a.method === 'GET');
        expect(get).toBeDefined();
        expect(get!.route).toBe('/users');
    });

    it('detects POST in same route file', () => {
        const source = `
export async function GET() { return Response.json([]); }
export async function POST(req: Request) { return Response.json({}); }
`;
        const apis = detectFrameworkApis(source, 'app/api/users/route.ts', 'typescript');
        expect(apis.find(a => a.method === 'GET')).toBeDefined();
        expect(apis.find(a => a.method === 'POST')).toBeDefined();
    });

    it('detects dynamic route segments', () => {
        const source = `export async function GET() { return Response.json({}); }`;
        const apis = detectFrameworkApis(source, 'app/api/users/[id]/route.ts', 'typescript');
        expect(apis[0].route).toBe('/users/[id]');
    });

    it('detects src/app/api prefix', () => {
        const source = `export async function DELETE() { return new Response(null); }`;
        const apis = detectFrameworkApis(source, 'src/app/api/posts/[id]/route.ts', 'typescript');
        expect(apis[0].route).toBe('/posts/[id]');
        expect(apis[0].method).toBe('DELETE');
    });

    it('does NOT detect in non-api directory', () => {
        const source = `export async function GET() { return null; }`;
        const apis = detectFrameworkApis(source, 'app/users/page.tsx', 'typescript');
        // SvelteKit pattern won't match (no +server), meta-framework needs app/api prefix
        const nextApis = apis.filter(a => a.route?.includes('users'));
        expect(nextApis).toHaveLength(0);
    });
});

// ─── Next.js Pages Router ────────────────────────────────────────────────────

describe('Next.js Pages Router', () => {
    it('detects default export handler', () => {
        const source = `export default function handler(req, res) { res.json({}); }`;
        const apis = detectFrameworkApis(source, 'pages/api/auth/login.ts', 'typescript');
        const any = apis.find(a => a.method === 'ANY');
        expect(any).toBeDefined();
        expect(any!.route).toBe('/auth/login');
    });

    it('detects src/pages/api prefix', () => {
        const source = `export default async function handler(req, res) { res.json({}); }`;
        const apis = detectFrameworkApis(source, 'src/pages/api/health.ts', 'typescript');
        expect(apis.find(a => a.route === '/health')).toBeDefined();
    });
});

// ─── Nuxt ────────────────────────────────────────────────────────────────────

describe('Nuxt server/api', () => {
    it('detects defineEventHandler', () => {
        const source = `export default defineEventHandler((event) => { return { status: 'ok' }; });`;
        const apis = detectFrameworkApis(source, 'server/api/health.ts', 'typescript');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].route).toBe('/health');
    });

    it('detects POST from filename convention', () => {
        const source = `export default defineEventHandler(async (event) => { return {}; });`;
        const apis = detectFrameworkApis(source, 'server/api/users.post.ts', 'typescript');
        expect(apis[0].method).toBe('POST');
    });

    it('defaults to GET without method suffix', () => {
        const source = `export default defineEventHandler(() => []);`;
        const apis = detectFrameworkApis(source, 'server/api/items.ts', 'typescript');
        expect(apis[0].method).toBe('GET');
    });

    it('does NOT detect outside server/api/', () => {
        const source = `export default defineEventHandler(() => []);`;
        const apis = detectFrameworkApis(source, 'composables/useAuth.ts', 'typescript');
        const nuxt = apis.filter(a => a.route !== '/');
        expect(nuxt).toHaveLength(0);
    });

    // #771 (2026-06-06) — Nuxt auto-imports `defineEventHandler` as
    // `eventHandler`. The bare alias is the form most fixtures use and
    // was previously not detected, leaving low API counts on real Nuxt
    // repos (ts-nuxt: 11 detected vs ~30-50 expected).
    it('detects the eventHandler alias (Nuxt auto-import)', () => {
        const source = `export default eventHandler((event) => { return { ok: true }; });`;
        const apis = detectFrameworkApis(source, 'server/api/ping.ts', 'typescript');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].route).toBe('/ping');
    });

    it('detects eventHandler with method-suffixed filename', () => {
        const source = `export default eventHandler(async (event) => { return await readBody(event); });`;
        const apis = detectFrameworkApis(source, 'server/api/auth/login.post.ts', 'typescript');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].method).toBe('POST');
        expect(apis[0].route).toBe('/auth/login');
    });

    it('detects an arrow-function eventHandler without an explicit default export', () => {
        const source = `const handler = eventHandler(() => ({ tick: Date.now() }));\nexport default handler;`;
        const apis = detectFrameworkApis(source, 'server/api/tick.get.ts', 'typescript');
        expect(apis.length).toBeGreaterThan(0);
        expect(apis[0].method).toBe('GET');
        expect(apis[0].route).toBe('/tick');
    });
});

// ─── Remix ───────────────────────────────────────────────────────────────────

describe('Remix loaders and actions', () => {
    it('detects export function loader as GET', () => {
        const source = `export async function loader({ request }) { return json({}); }`;
        const apis = detectFrameworkApis(source, 'app/routes/api.users.tsx', 'typescript');
        const loader = apis.find(a => a.method === 'GET' && a.handlerName === 'loader');
        expect(loader).toBeDefined();
    });

    it('detects export function action as POST', () => {
        const source = `export async function action({ request }) { return json({}); }`;
        const apis = detectFrameworkApis(source, 'app/routes/api.users.tsx', 'typescript');
        const action = apis.find(a => a.method === 'POST' && a.handlerName === 'action');
        expect(action).toBeDefined();
    });

    it('detects both loader and action in same file', () => {
        const source = `
export async function loader() { return json([]); }
export async function action({ request }) { return json({}); }
`;
        const apis = detectFrameworkApis(source, 'app/routes/api.todos.tsx', 'typescript');
        expect(apis.find(a => a.method === 'GET')).toBeDefined();
        expect(apis.find(a => a.method === 'POST')).toBeDefined();
    });
});

// ─── SvelteKit ───────────────────────────────────────────────────────────────

describe('SvelteKit +server.ts', () => {
    it('detects GET export', () => {
        const source = `export async function GET({ params }) { return json({}); }`;
        const apis = detectFrameworkApis(source, 'src/routes/api/data/+server.ts', 'typescript');
        expect(apis.find(a => a.method === 'GET' && a.route === '/api/data')).toBeDefined();
    });

    it('detects POST export', () => {
        const source = `export async function POST({ request }) { return json({}); }`;
        const apis = detectFrameworkApis(source, 'src/routes/api/submit/+server.ts', 'typescript');
        expect(apis[0].method).toBe('POST');
    });

    it('does NOT detect in +page.server.ts', () => {
        const source = `export async function GET() { return {}; }`;
        const apis = detectFrameworkApis(source, 'src/routes/dashboard/+page.server.ts', 'typescript');
        // +page.server is NOT +server, so SvelteKit pattern shouldn't match
        const svelte = apis.filter(a => a.route?.includes('dashboard'));
        expect(svelte).toHaveLength(0);
    });
});

// ─── tRPC ────────────────────────────────────────────────────────────────────

describe('tRPC procedures', () => {
    it('detects query procedure', () => {
        const source = `
const appRouter = router({
    getUsers: publicProcedure.query(async () => {
        return db.users.findMany();
    }),
});
`;
        const apis = detectFrameworkApis(source, 'src/server/trpc/router.ts', 'typescript');
        const query = apis.find(a => a.method === 'QUERY');
        expect(query).toBeDefined();
    });

    it('detects mutation procedure', () => {
        const source = `
const appRouter = router({
    createUser: publicProcedure.input(z.object({ name: z.string() })).mutation(async ({ input }) => {
        return db.users.create({ data: input });
    }),
});
`;
        const apis = detectFrameworkApis(source, 'src/server/trpc/router.ts', 'typescript');
        const mutation = apis.find(a => a.method === 'MUTATION');
        expect(mutation).toBeDefined();
    });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('Meta-framework edge cases', () => {
    it('empty file produces no APIs', () => {
        const apis = detectFrameworkApis('', 'app/api/test/route.ts', 'typescript');
        expect(apis).toHaveLength(0);
    });

    it('React component file with no exports does not match', () => {
        const source = `function UserList() { return <div>Users</div>; }`;
        const apis = detectFrameworkApis(source, 'app/users/page.tsx', 'typescript');
        expect(apis).toHaveLength(0);
    });

    it('Next.js layout file is not detected as API route', () => {
        const source = `export default function Layout({ children }) { return <div>{children}</div>; }`;
        const apis = detectFrameworkApis(source, 'app/api/users/layout.tsx', 'typescript');
        // default export matches Pages Router pattern but layout.tsx doesn't have pages/api prefix
        const apiRoutes = apis.filter(a => a.route?.includes('users'));
        expect(apiRoutes).toHaveLength(0);
    });

    it('non-handler export is not treated as API', () => {
        const source = `export const config = { runtime: 'edge' };`;
        const apis = detectFrameworkApis(source, 'app/api/test/route.ts', 'typescript');
        expect(apis).toHaveLength(0);
    });
});

// ─── Next.js Data Fetching ──────────────────────────────────────────────────

describe('Next.js Data Fetching', () => {
    it('detects getServerSideProps in pages/ files', () => {
        const source = `
export async function getServerSideProps(context) { return { props: {} }; }
export default function Page({ data }) { return <div>{data}</div>; }
`;
        const apis = detectFrameworkApis(source, 'pages/users/index.tsx', 'typescript');
        const df = apis.find(a => a.method === 'DATA_FETCH');
        expect(df).toBeDefined();
        expect(df!.handlerName).toBe('getServerSideProps');
    });

    it('detects getStaticProps', () => {
        const source = `export async function getStaticProps() { return { props: {} }; }`;
        const apis = detectFrameworkApis(source, 'pages/about.tsx', 'typescript');
        expect(apis.find(a => a.method === 'DATA_FETCH')).toBeDefined();
    });

    it('detects getStaticPaths', () => {
        const source = `export async function getStaticPaths() { return { paths: [], fallback: false }; }`;
        const apis = detectFrameworkApis(source, 'pages/posts/[id].tsx', 'typescript');
        expect(apis.find(a => a.method === 'STATIC_PATHS')).toBeDefined();
    });

    it('does NOT detect getServerSideProps in pages/api/ files', () => {
        const source = `export async function getServerSideProps() { return { props: {} }; }`;
        const apis = detectFrameworkApis(source, 'pages/api/users.ts', 'typescript');
        expect(apis.find(a => a.method === 'DATA_FETCH')).toBeUndefined();
    });
});

// ─── Next.js Server Actions ─────────────────────────────────────────────────

describe('Next.js Server Actions', () => {
    it('detects use server directive with exported function (#901 — ALL exports, not just first)', () => {
        const source = `'use server';
export async function createUser(formData: FormData) { /* ... */ }
export async function deleteUser(id: string) { /* ... */ }
`;
        const apis = detectFrameworkApis(source, 'app/actions/users.ts', 'typescript');
        const actions = apis.filter(a => a.method === 'SERVER_ACTION');
        // #901 — the old `'use server'[\s\S]*?export function` matched ONLY the
        // first export; now every export becomes its own SERVER_ACTION record.
        expect(actions.map(a => a.handlerName).sort()).toEqual(['createUser', 'deleteUser']);
    });

    it('#901 — 5 exports → 5 SERVER_ACTION records, no whole-path fallback route', () => {
        const source = `'use server';
export async function a() {}
export async function b() {}
export function c() {}
export async function d() {}
export function e() {}
`;
        const apis = detectFrameworkApis(source, 'lib/actions.ts', 'typescript');
        const actions = apis.filter(a => a.method === 'SERVER_ACTION');
        expect(actions.map(a => a.handlerName).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
        // All resolve to the inferred route, never a synthesized whole-path route.
        for (const act of actions) {
            expect(act.route).toBe('/actions');
            expect(act.route).not.toMatch(/lib\/actions/); // no `/lib/actions.ts` junk route
        }
    });

    it('does NOT detect use server in non-app directories', () => {
        const source = `'use server'; export async function test() {}`;
        const apis = detectFrameworkApis(source, 'utils/helper.ts', 'typescript');
        expect(apis.find(a => a.method === 'SERVER_ACTION')).toBeUndefined();
    });

    it('#901 — a file WITHOUT the use server directive yields no SERVER_ACTION', () => {
        const source = `export async function createUser() {}\nexport async function deleteUser() {}`;
        const apis = detectFrameworkApis(source, 'app/actions/users.ts', 'typescript');
        expect(apis.find(a => a.method === 'SERVER_ACTION')).toBeUndefined();
    });
});

// ─── Next.js Middleware ─────────────────────────────────────────────────────

describe('Next.js Middleware', () => {
    it('detects middleware.ts at project root', () => {
        const source = `export function middleware(request: NextRequest) { return NextResponse.next(); }`;
        const apis = detectFrameworkApis(source, 'middleware.ts', 'typescript');
        const mw = apis.find(a => a.method === 'MIDDLEWARE');
        expect(mw).toBeDefined();
        expect(mw!.route).toBe('/*');
    });

    it('detects middleware in src/ root', () => {
        const source = `export const middleware = async (request) => NextResponse.next();`;
        const apis = detectFrameworkApis(source, 'src/middleware.ts', 'typescript');
        expect(apis.find(a => a.method === 'MIDDLEWARE')).toBeDefined();
    });

    it('does NOT detect middleware in nested directories', () => {
        const source = `export function middleware(req) { return next(); }`;
        const apis = detectFrameworkApis(source, 'app/api/middleware.ts', 'typescript');
        expect(apis.find(a => a.method === 'MIDDLEWARE')).toBeUndefined();
    });
});

// ─── FastAPI APIRouter Prefix ───────────────────────────────────────────────

describe('FastAPI APIRouter Prefix', () => {
    it('prepends prefix from APIRouter to @router.get routes', () => {
        const source = `
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/todos", tags=["todos"])

@router.get("/")
async def get_todos():
    return []

@router.post("/")
async def create_todo(todo: TodoCreate):
    return todo

@router.get("/{todo_id}")
async def get_todo(todo_id: int):
    return todo
`;
        const apis = detectFrameworkApis(source, 'routes/todos.py', 'python');
        const getAll = apis.find(a => a.method === 'GET' && a.route === '/api/v1/todos');
        const create = apis.find(a => a.method === 'POST' && a.route === '/api/v1/todos');
        const getOne = apis.find(a => a.method === 'GET' && a.route?.includes('todo_id'));
        expect(getAll).toBeDefined();
        expect(create).toBeDefined();
        expect(getOne).toBeDefined();
    });

    it('handles router without prefix', () => {
        const source = `
router = APIRouter()

@router.get("/items")
async def get_items():
    return []
`;
        const apis = detectFrameworkApis(source, 'routes/items.py', 'python');
        const get = apis.find(a => a.method === 'GET' && a.route === '/items');
        expect(get).toBeDefined();
    });
});

// ─── Spring Security Annotations ────────────────────────────────────────────

describe('Spring Security Annotations', () => {
    it('detects @Secured on controller methods', () => {
        const source = `
@RestController
@RequestMapping("/api/admin")
public class AdminController {
    @Secured("ROLE_ADMIN")
    @GetMapping("/users")
    public List<User> getUsers() { return userService.findAll(); }
}
`;
        const apis = detectFrameworkApis(source, 'AdminController.java', 'java');
        const get = apis.find(a => a.method === 'GET' && a.route === '/api/admin/users');
        expect(get).toBeDefined();
    });

    it('detects @PreAuthorize annotation', () => {
        const source = `
@RestController
public class SecureController {
    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/users/{id}")
    public void deleteUser(@PathVariable Long id) {}
}
`;
        const apis = detectFrameworkApis(source, 'SecureController.java', 'java');
        expect(apis.find(a => a.method === 'DELETE')).toBeDefined();
    });
});

// ─── Node.js EventEmitter Detection ─────────────────────────────────────────

describe('Node.js EventEmitter Detection', () => {
    it('detects .on() event listener with EventEmitter import', () => {
        const source = `
import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.on('user:created', (user) => { sendWelcomeEmail(user); });
bus.on('order:placed', (order) => { processPayment(order); });
`;
        const apis = detectFrameworkApis(source, 'eventBus.ts', 'typescript');
        const listener = apis.find(a => a.method === 'EVENT_LISTENER' && a.route === '/event:user:created');
        expect(listener).toBeDefined();
        expect(apis.filter(a => a.method === 'EVENT_LISTENER')).toHaveLength(2);
    });

    it('detects .emit() event emission', () => {
        const source = `
import { EventEmitter } from 'events';

class UserService extends EventEmitter {
    createUser(data) {
        const user = db.create(data);
        this.emit('user:created', user);
        return user;
    }
}
`;
        const apis = detectFrameworkApis(source, 'userService.ts', 'typescript');
        expect(apis.find(a => a.method === 'EVENT_EMIT' && a.route === '/event:user:created')).toBeDefined();
    });

    it('does NOT detect .on() without EventEmitter import', () => {
        const source = `
// Regular DOM event listener
document.on('click', handler);
`;
        const apis = detectFrameworkApis(source, 'app.ts', 'typescript');
        expect(apis.find(a => a.method === 'EVENT_LISTENER')).toBeUndefined();
    });
});
