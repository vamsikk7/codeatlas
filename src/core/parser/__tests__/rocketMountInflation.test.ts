/**
 * rocketMountInflation.test.ts — BUG-EXP-17.
 *
 * Rocket's `.mount("/base", routes![h1, h2, h3])` used to emit one `MOUNT`
 * record PER handler in the `routes!` macro. But every handler is already
 * captured by its own `#[get]`/`#[post]` decorator, so each endpoint was
 * double-counted (rust-rocket: MOUNT 102 ≈ shadowing 76 verb handlers).
 *
 * A `.mount()` is the structural mount POINT — like Axum's `.nest()`, it
 * should contribute exactly ONE `MOUNT` record (the base path), not one per
 * mounted handler.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

const SRC = `
#[macro_use] extern crate rocket;

#[get("/foo")]
fn get_foo() -> &'static str { "foo" }

#[post("/foo")]
fn post_foo() -> &'static str { "foo" }

#[get("/bar")]
fn get_bar() -> &'static str { "bar" }

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![get_foo, post_foo, get_bar])
        .mount("/api", routes![get_bar])
}
`;

describe('BUG-EXP-17 — Rocket .mount() inflation', () => {
    const apis = detectFrameworkApis(SRC, 'src/main.rs', 'rust');
    const mounts = apis.filter(a => a.method === 'MOUNT');

    it('emits ONE MOUNT per mount() call, not one per handler', () => {
        // Two mount() calls → exactly two MOUNT records (NOT 3 + 1 = 4 handlers).
        expect(mounts.length).toBe(2);
    });

    it('MOUNT records carry the base path (the mount point)', () => {
        const routes = mounts.map(m => m.route).sort();
        expect(routes).toEqual(['/', '/api']);
    });

    it('still captures every #[verb] handler as its own record', () => {
        expect(apis.some(a => a.method === 'GET' && a.route === '/foo')).toBe(true);
        expect(apis.some(a => a.method === 'POST' && a.route === '/foo')).toBe(true);
        expect(apis.some(a => a.method === 'GET' && a.route === '/bar')).toBe(true);
    });

    it('a many-handler mount does not inflate MOUNT beyond one', () => {
        const big = detectFrameworkApis(
            `fn r() -> _ { rocket::build().mount("/", routes![a, b, c, d, e, f]) }`,
            'src/big.rs', 'rust',
        );
        expect(big.filter(a => a.method === 'MOUNT').length).toBe(1);
    });
});
