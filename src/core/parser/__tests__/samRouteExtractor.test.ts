/**
 * samRouteExtractor.test.ts — UX-24 (2026-06-04)
 *
 * AWS SAM templates (`template.yaml` / `template.yml`) declare HTTP
 * routes under `Resources.<FunctionName>.Type === 'AWS::Serverless::Function'`
 * with `Events.<EventName>.Type === 'Api' | 'HttpApi'`. CodeAtlas's
 * existing framework detectors don't read YAML, so these routes are
 * invisible — a single SAM tutorial repo can have 30+ routes and we
 * report 0 APIs. This extractor closes that gap.
 *
 * Tests cover the four shapes that the SAM spec + the two AWS sample
 * repos (sessions-with-aws-sam, serverless-patterns) actually emit:
 *
 *   1. AWS::Serverless::Function + Events.{Api,HttpApi}.Properties.{Path,Method}
 *   2. CodeUri-based handler resolution (handler in subfolder)
 *   3. Method='any' / 'ANY' → upper-cased to 'ANY'
 *   4. Multiple events per function → multiple ApiRecord rows
 */

import { describe, it, expect } from 'vitest';
import { parseSamTemplate } from '../samRouteExtractor';

describe('parseSamTemplate — UX-24', () => {
    it('returns [] for an empty / malformed template (no throw)', () => {
        expect(parseSamTemplate('', 'template.yaml')).toEqual([]);
        expect(parseSamTemplate('not: yaml: at: all:', 'template.yaml')).toEqual([]);
        expect(parseSamTemplate('Transform: AWS::Serverless-2016-10-31\nResources: {}', 'template.yaml')).toEqual([]);
    });

    it('returns [] when no AWS::Serverless::Function resources exist', () => {
        const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyBucket:
    Type: AWS::S3::Bucket
`;
        expect(parseSamTemplate(yaml, 'template.yaml')).toEqual([]);
    });

    it('extracts one Api event into one ApiRecord', () => {
        const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  HelloWorldFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.lambdaHandler
      Runtime: nodejs18.x
      Events:
        HelloWorldApi:
          Type: Api
          Properties:
            Path: /hello
            Method: get
`;
        const records = parseSamTemplate(yaml, 'sessions/01-hello/template.yaml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('GET');
        expect(records[0].route).toBe('/hello');
        expect(records[0].handlerName).toBe('HelloWorldFunction');
        // Path resolved relative to the template file: app.lambdaHandler → app.js next to template.yaml
        expect(records[0].filePath).toBe('sessions/01-hello/app.js');
    });

    it('extracts an HttpApi event the same way (HTTP API Gateway v2)', () => {
        const yaml = `
Transform: AWS::Serverless-2016-10-31
Resources:
  ListUsersFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.list
      Events:
        ListUsersHttp:
          Type: HttpApi
          Properties:
            Path: /users
            Method: GET
`;
        const records = parseSamTemplate(yaml, 'sample/template.yaml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('GET');
        expect(records[0].route).toBe('/users');
        expect(records[0].handlerName).toBe('ListUsersFn');
    });

    it('normalizes lower-case methods to upper-case', () => {
        const yaml = `
Transform: AWS::Serverless-2016-10-31
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.h
      Events:
        E1:
          Type: Api
          Properties:
            Path: /x
            Method: post
        E2:
          Type: Api
          Properties:
            Path: /y
            Method: any
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records.map(r => r.method).sort()).toEqual(['ANY', 'POST']);
    });

    it('emits one ApiRecord per Event when a function has multiple events', () => {
        const yaml = `
Transform: AWS::Serverless-2016-10-31
Resources:
  Multi:
    Type: AWS::Serverless::Function
    Properties:
      Handler: api.handler
      Events:
        GetItem:
          Type: Api
          Properties:
            Path: /items/{id}
            Method: get
        PutItem:
          Type: Api
          Properties:
            Path: /items/{id}
            Method: put
        DeleteItem:
          Type: Api
          Properties:
            Path: /items/{id}
            Method: delete
`;
        const records = parseSamTemplate(yaml, 'svc/template.yaml');
        expect(records).toHaveLength(3);
        expect(records.map(r => r.method).sort()).toEqual(['DELETE', 'GET', 'PUT']);
        expect(records.every(r => r.route === '/items/{id}')).toBe(true);
    });

    it('uses CodeUri to resolve the handler file when present', () => {
        const yaml = `
Resources:
  CodeUriFn:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/lambdas/users/
      Handler: handler.lambda_handler
      Runtime: python3.11
      Events:
        Get:
          Type: Api
          Properties: { Path: /users, Method: get }
`;
        const records = parseSamTemplate(yaml, 'app/template.yaml');
        // CodeUri is workspace-relative *to the template's dir* — resolves to
        // `app/src/lambdas/users/handler.py` (Python because Runtime hints it).
        expect(records[0].filePath).toBe('app/src/lambdas/users/handler.py');
    });

    it('infers handler-file extension from Runtime when no CodeUri (python)', () => {
        const yaml = `
Resources:
  PyFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.lambda_handler
      Runtime: python3.11
      Events:
        Get:
          Type: Api
          Properties:
            Path: /x
            Method: get
`;
        const records = parseSamTemplate(yaml, 'svc/template.yaml');
        expect(records[0].filePath).toBe('svc/app.py');
    });

    it('infers extension for Go and Java runtimes', () => {
        const yaml = `
Resources:
  GoFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: main
      Runtime: go1.x
      Events:
        Get:
          Type: Api
          Properties:
            Path: /go
            Method: get
  JavaFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: com.example.App::handleRequest
      Runtime: java17
      Events:
        Get:
          Type: Api
          Properties:
            Path: /java
            Method: get
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        const goRecord = records.find(r => r.route === '/go')!;
        const javaRecord = records.find(r => r.route === '/java')!;
        expect(goRecord.filePath).toMatch(/\.go$/);
        expect(javaRecord.filePath).toMatch(/\.java$/);
    });

    it('skips non-HTTP event types (S3 / SQS / Schedule / EventBridge) — UX-24 owns HTTP only', () => {
        const yaml = `
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        S3Trigger:
          Type: S3
          Properties:
            Events: "s3:ObjectCreated:*"
        Schedule:
          Type: Schedule
          Properties:
            Schedule: "rate(5 minutes)"
        SQS:
          Type: SQS
          Properties:
            Queue: arn:aws:sqs:us-east-1:0:Q
        Http:
          Type: Api
          Properties:
            Path: /only-this
            Method: get
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records).toHaveLength(1);
        expect(records[0].route).toBe('/only-this');
    });

    it('handles Globals.Api section (root-level path prefix)', () => {
        // Some SAM templates declare a Globals.Api.BasePath. The extractor
        // shouldn't crash on it. We don't apply the prefix in v1 (deferred).
        const yaml = `
Globals:
  Api:
    Cors:
      AllowOrigin: "'*'"
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        Get:
          Type: Api
          Properties:
            Path: /x
            Method: get
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records).toHaveLength(1);
    });

    it('skips resources without Events block (deployment-only functions)', () => {
        const yaml = `
Resources:
  CronFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Runtime: nodejs18.x
  ApiFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        G:
          Type: Api
          Properties:
            Path: /x
            Method: get
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records).toHaveLength(1);
        expect(records[0].handlerName).toBe('ApiFn');
    });

    it('reads Globals.Function.{Handler,Runtime,CodeUri} when per-function values are missing', () => {
        // Real SAM templates (e.g. sessions-with-aws-sam/http-api) declare
        // Handler / Runtime once under Globals.Function and inherit them
        // across every AWS::Serverless::Function. Without merging, the
        // extractor would map every function to a fake `handler.js`.
        const yaml = `
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Handler: app.lambdaHandler
    Runtime: nodejs16.x
Resources:
  HelloFn:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        Get:
          Type: HttpApi
          Properties:
            Path: /hello
            Method: get
  WorldFn:
    Type: AWS::Serverless::Function
    Properties:
      Events:
        Get:
          Type: HttpApi
          Properties:
            Path: /world
            Method: get
`;
        const records = parseSamTemplate(yaml, 'svc/template.yaml');
        expect(records).toHaveLength(2);
        // Both functions should resolve to the inherited handler file
        // (app.lambdaHandler → app.js).
        for (const rec of records) {
            expect(rec.filePath).toBe('svc/app.js');
        }
    });

    it('tolerates CloudFormation intrinsic tags (!Ref, !Sub, !GetAtt)', () => {
        // Real SAM templates routinely embed CFN intrinsics. The
        // FAILSAFE_SCHEMA in v1 of this extractor threw on these,
        // returning [] silently — so 100% of real-world templates
        // were skipped. The CFN_SCHEMA extension fixes that.
        const yaml = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Parameters:
  UserPoolId: { Type: String }
Resources:
  Auth:
    Type: AWS::Serverless::HttpApi
    Properties:
      Auth:
        Authorizers:
          GeneralAuth:
            IdentitySource: "$request.header.Authorization"
            JwtConfiguration:
              issuer: !Sub https://cognito-idp.\${AWS::Region}.amazonaws.com/\${UserPoolId}
              audience:
                - !Ref UserPoolId
  ApiFn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        Get:
          Type: HttpApi
          Properties:
            Path: /hello
            Method: get
            ApiId: !Ref Auth
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        // Critical: we don't crash on !Sub / !Ref. We extract the one Get route.
        expect(records).toHaveLength(1);
        expect(records[0].route).toBe('/hello');
    });

    it('treats HttpApi event with no Path/Method as ANY /$default (SAM catch-all)', () => {
        // Real-world: `sessions-with-aws-sam/http-api` has a
        // CatchAllLambdaFunction whose event is `Type: HttpApi` with no
        // Properties. In SAM this means "handle every path + method
        // not matched by another route". Render it as ANY /$default so
        // the route is visible.
        const yaml = `
Transform: AWS::Serverless-2016-10-31
Resources:
  CatchAll:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        RootGet:
          Type: HttpApi
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records).toHaveLength(1);
        expect(records[0].method).toBe('ANY');
        expect(records[0].route).toBe('/$default');
    });

    it('still skips Api (v1) events that omit Path/Method (malformed, not catch-all)', () => {
        // The catch-all default only applies to HttpApi (v2). For the
        // legacy Api type, missing Path/Method is just malformed and
        // should be skipped silently.
        const yaml = `
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        Malformed:
          Type: Api
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        expect(records).toHaveLength(0);
    });

    it('generates stable apiIds (no collisions on multi-route functions)', () => {
        const yaml = `
Resources:
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.h
      Events:
        E1:
          Type: Api
          Properties:
            Path: /a
            Method: get
        E2:
          Type: Api
          Properties:
            Path: /b
            Method: get
`;
        const records = parseSamTemplate(yaml, 'template.yaml');
        const ids = records.map(r => r.apiId);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
