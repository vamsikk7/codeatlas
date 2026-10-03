/**
 * anonRouteFinder.test.ts
 *
 * Issue 253 follow-up: verifies that anonymous route handler bodies are
 * located via tree-sitter AST traversal (not regex/Babel) for each
 * supported non-JS language. The body node's `.children` are statement
 * nodes consumable by buildFlowGraphFromBody.
 */

import { describe, it, expect } from 'vitest';
import { findAnonymousRouteBody } from '../anonRouteFinder';
import { buildFlowGraphFromBody } from '../../graph/flowGraphBuilder';

describe('findAnonymousRouteBody', () => {
    describe('Go (Gin)', () => {
        const code = `package main

import "github.com/gin-gonic/gin"

func setup() {
    r := gin.Default()
    r.GET("/users", func(c *gin.Context) {
        name := "alice"
        if name != "" {
            c.JSON(200, gin.H{"name": name})
        } else {
            c.JSON(404, nil)
        }
    })
    r.POST("/users", func(c *gin.Context) {
        c.JSON(201, nil)
    })
}`;

        it('finds GET handler body', async () => {
            const body = await findAnonymousRouteBody(code, 'go', 'GET', '/users');
            expect(body).not.toBeNull();
            expect(body!.type).toBe('block');
            // Body should contain the if_statement
            expect(body!.children.some(c => c.type === 'if_statement')).toBe(true);
        });

        it('disambiguates GET vs POST on same path', async () => {
            const get = await findAnonymousRouteBody(code, 'go', 'GET', '/users');
            const post = await findAnonymousRouteBody(code, 'go', 'POST', '/users');
            expect(get).not.toBeNull();
            expect(post).not.toBeNull();
            expect(get!.startIndex).not.toBe(post!.startIndex);
        });

        it('returns null when route does not exist', async () => {
            const body = await findAnonymousRouteBody(code, 'go', 'GET', '/missing');
            expect(body).toBeNull();
        });

        it('builds a flow graph with decision node from extracted body', async () => {
            const body = await findAnonymousRouteBody(code, 'go', 'GET', '/users');
            const graph = buildFlowGraphFromBody(body, code, 'main.go', 'anonymous@GET:/users');
            // Start, End, decision, plus statements
            expect(graph.nodes.find(n => n.type === 'decision')).toBeDefined();
            expect(graph.nodes.length).toBeGreaterThan(2);
        });
    });

    describe('Rust (Axum)', () => {
        const code = `use axum::Router;
use axum::routing::get;

fn app() -> Router {
    Router::new().route("/users", get(|| async {
        let name = "alice";
        if !name.is_empty() {
            "ok"
        } else {
            "none"
        }
    }))
}`;

        it('finds GET handler body inside async closure', async () => {
            const body = await findAnonymousRouteBody(code, 'rust', 'GET', '/users');
            expect(body).not.toBeNull();
            expect(body!.type).toBe('block');
        });

        it('does not match unrelated `get()` calls outside .route()', async () => {
            const noisy = `use std::collections::HashMap;
fn other() {
    let map = HashMap::new();
    map.get("/users");  // not a route handler
}` + '\n' + code;
            const body = await findAnonymousRouteBody(noisy, 'rust', 'GET', '/users');
            // Should still find the real route handler, not the map.get call
            expect(body).not.toBeNull();
            expect(body!.type).toBe('block');
        });
    });

    describe('Kotlin (Ktor)', () => {
        const code = `fun configureRouting() {
    routing {
        get("/users") {
            val name = "alice"
            if (name.isNotEmpty()) {
                call.respond(name)
            } else {
                call.respond("none")
            }
        }
        post("/users") {
            call.respond("created")
        }
    }
}`;

        it('finds GET handler statements', async () => {
            const body = await findAnonymousRouteBody(code, 'kotlin', 'GET', '/users');
            expect(body).not.toBeNull();
            expect(body!.type).toBe('statements');
            expect(body!.children.some(c => c.type === 'if_expression')).toBe(true);
        });

        it('disambiguates GET vs POST', async () => {
            const get = await findAnonymousRouteBody(code, 'kotlin', 'GET', '/users');
            const post = await findAnonymousRouteBody(code, 'kotlin', 'POST', '/users');
            expect(get).not.toBeNull();
            expect(post).not.toBeNull();
            expect(get!.startIndex).not.toBe(post!.startIndex);
        });

        it('does not collide with widget.get(...) calls', async () => {
            const noisy = `fun decorate() {
    val widget = mapOf("/users" to "x")
    widget.get("/users")
}
` + code;
            const body = await findAnonymousRouteBody(noisy, 'kotlin', 'GET', '/users');
            // Only matches the trailing-lambda form; map.get() has no trailing lambda
            expect(body).not.toBeNull();
            expect(body!.type).toBe('statements');
        });
    });

    describe('Ruby (Sinatra)', () => {
        const code = `get '/users' do
  name = "alice"
  if !name.empty?
    "ok"
  else
    "none"
  end
end

post '/users' do
  "created"
end`;

        it('finds GET handler body_statement', async () => {
            const body = await findAnonymousRouteBody(code, 'ruby', 'GET', '/users');
            expect(body).not.toBeNull();
            expect(body!.type).toBe('body_statement');
        });

        it('disambiguates GET vs POST', async () => {
            const get = await findAnonymousRouteBody(code, 'ruby', 'GET', '/users');
            const post = await findAnonymousRouteBody(code, 'ruby', 'POST', '/users');
            expect(get!.startIndex).not.toBe(post!.startIndex);
        });
    });

    describe('PHP (Laravel)', () => {
        const code = `<?php

Route::get('/users', function ($req) {
    $name = "alice";
    if (!empty($name)) {
        return response()->json($name);
    }
    return response()->json(null);
});

Route::post('/users', function ($req) {
    return response()->json("created");
});`;

        it('finds GET handler compound_statement', async () => {
            const body = await findAnonymousRouteBody(code, 'php', 'GET', '/users');
            expect(body).not.toBeNull();
            expect(body!.type).toBe('compound_statement');
            expect(body!.children.some(c => c.type === 'if_statement')).toBe(true);
        });

        it('disambiguates GET vs POST', async () => {
            const get = await findAnonymousRouteBody(code, 'php', 'GET', '/users');
            const post = await findAnonymousRouteBody(code, 'php', 'POST', '/users');
            expect(get!.startIndex).not.toBe(post!.startIndex);
        });
    });

    describe('flow graph integration', () => {
        it('Kotlin body produces decision node in flow graph', async () => {
            const code = `fun configureRouting() {
    routing {
        get("/users") {
            val name = "alice"
            if (name.isNotEmpty()) {
                call.respond(name)
            }
        }
    }
}`;
            const body = await findAnonymousRouteBody(code, 'kotlin', 'GET', '/users');
            const graph = buildFlowGraphFromBody(body, code, 'app.kt', 'anonymous@GET:/users');
            expect(graph.nodes.find(n => n.type === 'decision')).toBeDefined();
        });

        it('Ruby body produces decision node in flow graph', async () => {
            const code = `get '/users' do
  if name
    "ok"
  end
end`;
            const body = await findAnonymousRouteBody(code, 'ruby', 'GET', '/users');
            const graph = buildFlowGraphFromBody(body, code, 'app.rb', 'anonymous@GET:/users');
            expect(graph.nodes.find(n => n.type === 'decision')).toBeDefined();
        });

        it('PHP body produces decision node in flow graph', async () => {
            const code = `<?php
Route::get('/users', function () {
    if ($x) {
        return 1;
    }
    return 0;
});`;
            const body = await findAnonymousRouteBody(code, 'php', 'GET', '/users');
            const graph = buildFlowGraphFromBody(body, code, 'web.php', 'anonymous@GET:/users');
            expect(graph.nodes.find(n => n.type === 'decision')).toBeDefined();
        });
    });
});
