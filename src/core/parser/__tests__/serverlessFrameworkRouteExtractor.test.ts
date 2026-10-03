/**
 * serverlessFrameworkRouteExtractor.test.ts — UX-25 (2026-06-04)
 *
 * Serverless Framework `serverless.yml` declares HTTP routes under
 *   functions.<name>.events:
 *     - http:                    (REST API Gateway / v1)
 *         path: /hello
 *         method: get
 *     - httpApi:                 (HTTP API Gateway / v2)
 *         path: /world
 *         method: post
 *     - websocket:               (WebSocket API)
 *         route: $connect
 *
 * Shape parallels SAM but the keys differ. Multi-provider (AWS / Azure /
 * GCP / Cloudflare / Knative) — same YAML structure across providers.
 */

import { describe, it, expect } from 'vitest';
import { parseServerlessFrameworkTemplate } from '../serverlessFrameworkRouteExtractor';

describe('parseServerlessFrameworkTemplate — UX-25', () => {
    it('returns [] for empty / malformed input', () => {
        expect(parseServerlessFrameworkTemplate('', 'serverless.yml')).toEqual([]);
        expect(parseServerlessFrameworkTemplate('not: yaml: at: all:', 'serverless.yml')).toEqual([]);
        expect(parseServerlessFrameworkTemplate('service: foo\nfunctions: {}', 'serverless.yml')).toEqual([]);
    });

    it('returns [] when no functions block exists', () => {
        const yaml = `
service: my-svc
provider:
  name: aws
  runtime: nodejs18.x
`;
        expect(parseServerlessFrameworkTemplate(yaml, 'serverless.yml')).toEqual([]);
    });

    it('extracts a single REST API Gateway (http:) event', () => {
        const yaml = `
service: hello-world
provider:
  name: aws
  runtime: nodejs18.x
functions:
  hello:
    handler: handler.hello
    events:
      - http:
          path: /hello
          method: get
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'sample/serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('GET');
        expect(records[0].route).toBe('/hello');
        expect(records[0].handlerName).toBe('hello');
        expect(records[0].filePath).toBe('sample/handler.js');
    });

    it('extracts httpApi events (API Gateway v2)', () => {
        const yaml = `
service: v2
provider: { name: aws, runtime: nodejs18.x }
functions:
  list:
    handler: src/list.run
    events:
      - httpApi:
          path: /users
          method: GET
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].route).toBe('/users');
        expect(records[0].filePath).toBe('src/list.js');
    });

    it('extracts websocket events', () => {
        const yaml = `
service: ws
provider: { name: aws, runtime: nodejs18.x }
functions:
  connect:
    handler: handler.connect
    events:
      - websocket:
          route: $connect
  message:
    handler: handler.message
    events:
      - websocket: $default
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(2);
        const methods = records.map(r => r.method);
        expect(methods.every(m => m === 'WS')).toBe(true);
        // String-form websocket value gets used as the route.
        expect(records.find(r => r.handlerName === 'message')?.route).toBe('$default');
    });

    it('normalizes lower-case methods to upper-case', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  f:
    handler: app.h
    events:
      - http:
          path: /x
          method: post
      - http:
          path: /y
          method: any
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records.map(r => r.method).sort()).toEqual(['ANY', 'POST']);
    });

    it('emits one ApiRecord per http event when a function has multiple', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  crud:
    handler: crud.handler
    events:
      - http:
          path: /items/{id}
          method: get
      - http:
          path: /items/{id}
          method: put
      - http:
          path: /items/{id}
          method: delete
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'svc/serverless.yml');
        expect(records).toHaveLength(3);
        expect(records.map(r => r.method).sort()).toEqual(['DELETE', 'GET', 'PUT']);
    });

    it('infers handler extension from provider.runtime (python)', () => {
        const yaml = `
service: py
provider:
  name: aws
  runtime: python3.11
functions:
  hello:
    handler: app.lambda_handler
    events:
      - http:
          path: /x
          method: get
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'svc/serverless.yml');
        expect(records[0].filePath).toBe('svc/app.py');
    });

    it('per-function runtime override beats provider default', () => {
        const yaml = `
service: mixed
provider:
  name: aws
  runtime: nodejs18.x
functions:
  pyFn:
    handler: app.lambda_handler
    runtime: python3.11
    events:
      - http:
          path: /py
          method: get
  jsFn:
    handler: app.handler
    events:
      - http:
          path: /js
          method: get
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records.find(r => r.route === '/py')?.filePath).toMatch(/\.py$/);
        expect(records.find(r => r.route === '/js')?.filePath).toMatch(/\.js$/);
    });

    it('skips non-HTTP events (s3 / sqs / schedule / sns / eventBridge)', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  f:
    handler: app.handler
    events:
      - s3:
          bucket: my-bucket
          event: s3:ObjectCreated:*
      - schedule: rate(5 minutes)
      - sqs:
          arn: arn:aws:sqs:us-east-1:0:Q
      - sns: my-topic
      - eventBridge:
          eventBus: default
          pattern:
            source:
              - aws.ec2
      - http:
          path: /only-this
          method: get
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].route).toBe('/only-this');
    });

    it('supports the short-form http: "GET /path" syntax', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  hello:
    handler: handler.hello
    events:
      - http: GET hello
      - http: POST /users
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(2);
        const get = records.find(r => r.method === 'GET');
        const post = records.find(r => r.method === 'POST');
        expect(get?.route).toBe('/hello');
        expect(post?.route).toBe('/users');
    });

    it('handles multiple functions in one template', () => {
        const yaml = `
service: multi
provider: { name: aws, runtime: nodejs18.x }
functions:
  fa:
    handler: a.run
    events: [{ http: { path: /a, method: get } }]
  fb:
    handler: b.run
    events: [{ http: { path: /b, method: post } }]
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'svc/serverless.yml');
        expect(records).toHaveLength(2);
        expect(new Set(records.map(r => r.handlerName))).toEqual(new Set(['fa', 'fb']));
    });

    it('generates stable apiIds (no collisions)', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  f:
    handler: app.h
    events:
      - http: { path: /a, method: get }
      - http: { path: /b, method: get }
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        const ids = records.map(r => r.apiId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // UX-25 (2026-06-05) — gap-closing tests from the serverless/examples
    // real-world audit. Three shapes the extractor didn't handle previously.
    it('UX-25 gap 1: `httpApi: "*"` wildcard short-form (AWS v2 catch-all)', () => {
        const yaml = `
service: aws-node-express-api
provider:
  name: aws
  runtime: nodejs20.x
functions:
  api:
    handler: handler.handler
    events:
      - httpApi: "*"
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'aws-node-express-api/serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('ANY');
        expect(records[0].route).toBe('/*');
        expect(records[0].handlerName).toBe('api');
    });

    it('UX-25 gap 2: `http: true` boolean short-form (Azure Functions)', () => {
        const yaml = `
service: azfx-node-http
provider:
  name: azure
  location: West US
functions:
  hello:
    handler: handler.hello
    events:
      - http: true
        x-azure-settings:
          authLevel: anonymous
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'azure-node-simple-http-endpoint/serverless.yml');
        expect(records).toHaveLength(1);
        // Azure default method = ANY; route falls back to the function name.
        expect(records[0].method).toBe('ANY');
        expect(records[0].route).toBe('/hello');
        expect(records[0].handlerName).toBe('hello');
    });

    it('UX-25 gap 3: `http: path` single-word string (Google Cloud Functions)', () => {
        const yaml = `
service: node-simple-http-endpoint
provider:
  name: google
  runtime: nodejs8
functions:
  helloWorld:
    handler: http
    events:
      - http: path
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'google-node-simple-http-endpoint/serverless.yml');
        expect(records).toHaveLength(1);
        // GCF: default method GET, route is the literal path.
        expect(records[0].method).toBe('GET');
        expect(records[0].route).toBe('/path');
        expect(records[0].handlerName).toBe('helloWorld');
    });

    it('UX-25 gap 4: yaml.load tolerates CFN tags (`!GetAtt`, `!Ref`, …) — no whole-template bail', () => {
        const yaml = `
service: serverless-ruby-sqs-dynamodb
provider:
  name: aws
  runtime: ruby2.7
  iam:
    role:
      statements:
        - Effect: Allow
          Resource:
            - !GetAtt Table.Arn
functions:
  createLotteryCoupon:
    handler: src/handlers/lottery/handler.run
    events:
      - http:
          method: post
          path: lottery
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('POST');
        expect(records[0].route).toBe('/lottery');
    });

    it('UX-25 gap 5: stepFunctions.stateMachines.<name>.events.- http: routes are extracted', () => {
        const yaml = `
service: aws-ruby-step-functions
provider:
  name: aws
  runtime: ruby2.7
functions:
  send-email:
    handler: src/handlers/send_email/handler.run

stepFunctions:
  stateMachines:
    myStateMachine:
      type: EXPRESS
      events:
        - http:
            path: employees/add
            method: POST
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        const sm = records.find((r) => r.route === '/employees/add');
        expect(sm).toBeDefined();
        expect(sm?.method).toBe('POST');
        expect(sm?.handlerName).toBe('myStateMachine');
    });

    it('UX-25 gap 6: Azure x-azure-settings shape `route:` + `methods:[...]` array', () => {
        const yaml = `
service: service-bus-trigger-example
provider:
  name: azure
functions:
  sendMessage:
    handler: src/controller/messageSenderController.sendMessage
    events:
      - http:
          x-azure-settings:
            name: req
            methods:
              - post
              - put
            route: api/v3/send
            authLevel: anonymous
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records.length).toBeGreaterThanOrEqual(1);
        const post = records.find((r) => r.method === 'POST');
        expect(post?.route).toBe('/api/v3/send');
        expect(post?.handlerName).toBe('sendMessage');
    });

    it('UX-25 gap 1b: `http: "*"` wildcard short-form ALSO supported (REST v1)', () => {
        const yaml = `
service: x
provider: { name: aws }
functions:
  api:
    handler: app.h
    events:
      - http: "*"
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('ANY');
        expect(records[0].route).toBe('/*');
    });

    // #810 (2026-06-10) — .NET handler resolver was stripping the namespace
    // path before the class name. For the canonical assembly-prefixed shape
    // `<assembly>::<assembly.namespace.Class>::<method>` the resolver was
    // returning `<templateDir>/Class.cs` instead of
    // `<templateDir>/namespace/Class.cs`. Every L2b cluster + L1 service
    // node showed `0 APIs` because the IaC-derived `filePath` never matched
    // the real cluster files. Live-traced on
    // `aws-dotnet-rest-api-with-dynamodb/.../serverless.yml`.
    it('UX-25 #810: .NET handler preserves namespace path under assembly prefix', () => {
        const yaml = `
service: dotnet-app
provider:
  name: aws
  runtime: dotnetcore2.1
functions:
  create:
    handler: DotNetServerless.Lambda::DotNetServerless.Lambda.Functions.CreateItemFunction::Run
    events:
      - http:
          path: items
          method: post
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'src/DotNetServerless.Lambda/serverless.yml');
        expect(records).toHaveLength(1);
        expect(records[0].filePath).toBe('src/DotNetServerless.Lambda/Functions/CreateItemFunction.cs');
    });

    it('UX-25 #810: .NET handler without matching assembly prefix preserves the full namespace path', () => {
        const yaml = `
service: dotnet-app
provider:
  name: aws
  runtime: dotnetcore3.1
functions:
  handler:
    handler: MyApp::Other.Namespace.MyHandler::Run
    events:
      - http:
          path: x
          method: get
`;
        const records = parseServerlessFrameworkTemplate(yaml, 'svc/serverless.yml');
        expect(records[0].filePath).toBe('svc/Other/Namespace/MyHandler.cs');
    });
});
