/**
 * cdkConstructExtractor.test.ts — UX-26 (2026-06-05).
 *
 * AWS CDK construct chains define HTTP routes in TypeScript/Python
 * code (not YAML). Two dominant shapes:
 *   1. REST API v1: `api.root.addResource('users').addMethod('GET', ...)`
 *   2. HTTP API v2: `httpApi.addRoutes({ path: '/foo', methods: [HttpMethod.GET], ... })`
 * Plus Python snake_case equivalents.
 */
import { describe, it, expect } from 'vitest';
import { parseCdkConstructs, isCdkLikely } from '../cdkConstructExtractor';

describe('isCdkLikely', () => {
    it('returns true for files importing aws-cdk-lib', () => {
        const ts = `import { Stack } from 'aws-cdk-lib';\nimport { RestApi } from 'aws-cdk-lib/aws-apigateway';`;
        expect(isCdkLikely(ts)).toBe(true);
    });
    it('returns true for files importing @aws-cdk/*', () => {
        const ts = `import * as apigw from '@aws-cdk/aws-apigateway-alpha';`;
        expect(isCdkLikely(ts)).toBe(true);
    });
    it('returns true for Python CDK imports', () => {
        const py = `from aws_cdk import aws_apigateway as apigw`;
        expect(isCdkLikely(py)).toBe(true);
    });
    it('returns false for unrelated source', () => {
        expect(isCdkLikely(`import express from 'express';`)).toBe(false);
        expect(isCdkLikely('')).toBe(false);
    });
});

describe('parseCdkConstructs — REST API v1 (TypeScript)', () => {
    it('extracts a single .addMethod chain', () => {
        const source = `
import { RestApi, LambdaIntegration } from 'aws-cdk-lib/aws-apigateway';
const api = new RestApi(this, 'Api');
const items = api.root.addResource('items');
items.addMethod('GET', new LambdaIntegration(listFn));
items.addMethod('POST', new LambdaIntegration(createFn));
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes).toHaveLength(2);
        const get = routes.find(r => r.method === 'GET');
        const post = routes.find(r => r.method === 'POST');
        expect(get?.route).toBe('/items');
        expect(post?.route).toBe('/items');
    });

    it('handles inline chain api.root.addResource("users").addMethod("GET", ...)', () => {
        const source = `
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
const api = new RestApi(this, 'Api');
api.root.addResource('users').addMethod('GET', integration);
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'GET', route: '/users' });
    });

    it('handles nested addResource (multi-segment path)', () => {
        const source = `
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
const api = new RestApi(this, 'Api');
const usersResource = api.root.addResource('users');
const userById = usersResource.addResource('{userId}');
userById.addMethod('GET', integration);
userById.addMethod('DELETE', integration);
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        const get = routes.find(r => r.method === 'GET');
        expect(get?.route).toBe('/users/{userId}');
        const del = routes.find(r => r.method === 'DELETE');
        expect(del?.route).toBe('/users/{userId}');
    });

    it('returns [] when no CDK constructs are found', () => {
        const source = `import express from 'express';\nconst app = express();\napp.get('/x', h);`;
        expect(parseCdkConstructs(source, 'src/app.ts')).toEqual([]);
    });
});

describe('parseCdkConstructs — HTTP API v2 (TypeScript)', () => {
    it('extracts a single addRoutes call', () => {
        const source = `
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
const httpApi = new HttpApi(this, 'HttpApi');
httpApi.addRoutes({
  path: '/protected',
  methods: [HttpMethod.GET],
  integration: new HttpLambdaIntegration('foo', fn),
});
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'GET', route: '/protected' });
    });

    it('extracts multiple methods from a methods array', () => {
        const source = `
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
const httpApi = new HttpApi(this, 'HttpApi');
httpApi.addRoutes({
  path: '/items',
  methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
});
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes.map(r => r.method).sort()).toEqual(['DELETE', 'GET', 'POST']);
        for (const r of routes) expect(r.route).toBe('/items');
    });

    it('handles ANY method via [HttpMethod.ANY]', () => {
        const source = `
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
const httpApi = new HttpApi(this, 'HttpApi');
httpApi.addRoutes({
  path: '/wildcard',
  methods: [HttpMethod.ANY],
});
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'ANY', route: '/wildcard' });
    });

    it('handles bare method strings (no HttpMethod prefix)', () => {
        const source = `
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
const httpApi = new HttpApi(this, 'HttpApi');
httpApi.addRoutes({
  path: '/foo',
  methods: ['GET', 'POST'],
});
`;
        const routes = parseCdkConstructs(source, 'lib/stack.ts');
        expect(routes.map(r => r.method).sort()).toEqual(['GET', 'POST']);
    });
});

describe('parseCdkConstructs — Java CDK (UX-26 Phase 2)', () => {
    it('extracts api.getRoot().addMethod("GET", integration) inline chain', () => {
        const source = `
package com.myorg;
import software.amazon.awscdk.services.apigateway.RestApi;
import software.amazon.awscdk.services.apigateway.LambdaIntegration;

public class MyStack {
    RestApi api = new RestApi(this, "api");
    api.getRoot().addMethod("GET", integration);
}
`;
        const routes = parseCdkConstructs(source, 'src/main/java/MyStack.java');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'GET', route: '/' });
    });

    it('extracts addResource + addMethod chain with getRoot()', () => {
        const source = `
import software.amazon.awscdk.services.apigateway.*;
public class MyStack {
    Resource items = api.getRoot().addResource("items");
    items.addMethod("GET", listIntegration);
    items.addMethod("POST", createIntegration);
}
`;
        const routes = parseCdkConstructs(source, 'src/main/java/MyStack.java');
        const get = routes.find(r => r.method === 'GET');
        const post = routes.find(r => r.method === 'POST');
        expect(get?.route).toBe('/items');
        expect(post?.route).toBe('/items');
    });

    it('isCdkLikely matches Java software.amazon.awscdk imports', () => {
        expect(isCdkLikely(`import software.amazon.awscdk.services.apigateway.RestApi;`)).toBe(true);
        expect(isCdkLikely(`import software.amazon.awscdk.*;`)).toBe(true);
    });
});

describe('parseCdkConstructs — Cross-stack route propagation (UX-26 Phase 3)', () => {
    it('extracts routes from a child stack that receives a RestApi via props', () => {
        const source = `
import { Stack, StackProps } from 'aws-cdk-lib';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';

interface ChildStackProps extends StackProps {
    api: RestApi;
}

class ChildStack extends Stack {
    constructor(scope: any, id: string, props: ChildStackProps) {
        super(scope, id, props);
        const items = props.api.root.addResource('items');
        items.addMethod('GET', listIntegration);
        items.addMethod('POST', createIntegration);
    }
}

class ParentStack extends Stack {
    constructor() {
        const api = new RestApi(this, 'Api');
        new ChildStack(this, 'Child', { api });
    }
}
`;
        const routes = parseCdkConstructs(source, 'lib/stacks.ts');
        const get = routes.find(r => r.method === 'GET');
        const post = routes.find(r => r.method === 'POST');
        expect(get?.route).toBe('/items');
        expect(post?.route).toBe('/items');
    });

    it('inline chain works with props.api.root.addResource().addMethod()', () => {
        const source = `
import { RestApi } from 'aws-cdk-lib/aws-apigateway';

class ChildStack {
    constructor(props) {
        props.api.root.addResource('users').addMethod('GET', integration);
    }
}
`;
        const routes = parseCdkConstructs(source, 'lib/child.ts');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'GET', route: '/users' });
    });

    it('this.api.root.addMethod() pattern (api stored on stack instance)', () => {
        const source = `
import { RestApi } from 'aws-cdk-lib/aws-apigateway';

class ApiStack {
    constructor() {
        this.api = new RestApi(this, 'Api');
        this.api.root.addMethod('GET', integration);
    }
}
`;
        const routes = parseCdkConstructs(source, 'lib/api.ts');
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ method: 'GET', route: '/' });
    });
});

describe('isCdkLikely — UX-26 Phase 4: API-usage detection without explicit import', () => {
    it('detects CDK file that uses .root.addMethod() even without aws-cdk-lib import', () => {
        const ts = `
import type { RestApi } from '../types';  // relative re-export, not aws-cdk-lib

export class ChildStack {
    constructor(scope: any, id: string, props: { api: RestApi }) {
        props.api.root.addResource('items').addMethod('GET', integration);
    }
}
`;
        expect(isCdkLikely(ts)).toBe(true);
    });

    it('detects CDK file that uses addRoutes() without explicit import', () => {
        const ts = `
import type { HttpApi } from '../shared';
export class V2Stack {
    constructor(props: { httpApi: HttpApi }) {
        props.httpApi.addRoutes({ path: '/items', methods: ['GET'] });
    }
}
`;
        expect(isCdkLikely(ts)).toBe(true);
    });

    it('does NOT falsely classify random JS that happens to call .addMethod()', () => {
        // No `extends Stack`, no `RestApi`/`HttpApi`/`getRoot` mention,
        // no `addResource` — just a plain `.addMethod` on a non-CDK
        // object. Should NOT trip the probe.
        const ts = `
class CustomBuilder {
    constructor() {}
    addMethod(name) { /* unrelated */ }
}
new CustomBuilder().addMethod('foo');
`;
        expect(isCdkLikely(ts)).toBe(false);
    });

    it('multi-file: TS-annotated resource decls (`const x: Resource = ...`) → routes extracted', () => {
        // Phase 4 follow-up (2026-06-05) — TS users commonly annotate the
        // declared resource variable with its type: `const users: Resource
        // = api.root.addResource('users')`. The RESOURCE_DECL_RE pattern
        // must accept an optional `: TypeName` between the name and the
        // assignment so the variable is recorded in the path map.
        const source = `
import type { RestApi, Resource } from './types';

export class ChildStack {
    constructor(props: { api: RestApi }) {
        const users: Resource = props.api.root.addResource('users');
        users.addMethod('GET');
        users.addMethod('POST');
        const userId: Resource = users.addResource('{id}');
        userId.addMethod('GET');
        userId.addMethod('DELETE');
    }
}
`;
        const routes = parseCdkConstructs(source, 'lib/child-stack.ts');
        expect(routes.find(r => r.method === 'GET' && r.route === '/users')).toBeDefined();
        expect(routes.find(r => r.method === 'POST' && r.route === '/users')).toBeDefined();
        expect(routes.find(r => r.method === 'GET' && r.route === '/users/{id}')).toBeDefined();
        expect(routes.find(r => r.method === 'DELETE' && r.route === '/users/{id}')).toBeDefined();
    });

    it('multi-file: child stack file with relative RestApi import → routes extracted', () => {
        // This is the canonical Phase 4 case: child stack lives in its
        // own file, imports RestApi via a relative path (not aws-cdk-lib
        // directly because the parent module re-exports), but uses the
        // canonical CDK API. With API-usage detection, this file is
        // recognized and its routes are emitted.
        const source = `
import type { RestApi } from '../shared/api-types';

interface ChildProps {
    api: RestApi;
}

export class ChildStack {
    constructor(scope: any, id: string, props: ChildProps) {
        const items = props.api.root.addResource('items');
        items.addMethod('GET', listIntegration);
        items.addMethod('POST', createIntegration);
        items.addResource('{id}').addMethod('DELETE', deleteIntegration);
    }
}
`;
        const routes = parseCdkConstructs(source, 'lib/child-stack.ts');
        const get = routes.find(r => r.method === 'GET' && r.route === '/items');
        const post = routes.find(r => r.method === 'POST' && r.route === '/items');
        const del = routes.find(r => r.method === 'DELETE');
        expect(get).toBeDefined();
        expect(post).toBeDefined();
        expect(del?.route).toBe('/items/{id}');
    });
});

describe('parseCdkConstructs — Python CDK', () => {
    it('extracts add_resource + add_method chain (snake_case)', () => {
        const source = `
from aws_cdk import aws_apigateway as apigw
api = apigw.RestApi(self, "Api")
items = api.root.add_resource("items")
items.add_method("GET", integration)
items.add_method("POST", integration)
`;
        const routes = parseCdkConstructs(source, 'stack/app.py');
        const get = routes.find(r => r.method === 'GET');
        const post = routes.find(r => r.method === 'POST');
        expect(get?.route).toBe('/items');
        expect(post?.route).toBe('/items');
    });

    it('extracts add_routes for HTTP API v2 (snake_case)', () => {
        const source = `
from aws_cdk import aws_apigatewayv2_alpha as apigwv2
http_api = apigwv2.HttpApi(self, "HttpApi")
http_api.add_routes(
    path="/secure",
    methods=[apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
)
`;
        const routes = parseCdkConstructs(source, 'stack/app.py');
        expect(routes.map(r => `${r.method} ${r.route}`).sort()).toEqual(['GET /secure', 'POST /secure']);
    });
});
