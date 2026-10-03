/**
 * slsResourceExtractor.test.ts — UX-54c (2026-06-06).
 *
 * Verifies Serverless Framework `serverless.yml` resource declarations
 * (embedded under `resources.Resources`) lift to the same shape SAM and
 * CDK emit.
 */
import { describe, it, expect } from 'vitest';
import {
    parseSlsResources,
    slsResourcesToInfraServices,
    isSlsLikely,
} from '../slsResourceExtractor';

describe('slsResourceExtractor — UX-54c', () => {
    it('detects DynamoDB + SQS under resources.Resources', () => {
        const tpl = `
service: my-service
provider:
  name: aws
functions:
  hello:
    handler: handler.hello
resources:
  Resources:
    ItemsTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: items
    TasksQueue:
      Type: AWS::SQS::Queue
`;
        const hits = parseSlsResources(tpl);
        expect(hits.map(h => h.type).sort()).toEqual([
            'AWS::DynamoDB::Table',
            'AWS::SQS::Queue',
        ]);
    });

    it('detects Kinesis Stream + S3 Bucket', () => {
        const tpl = `
service: stream-svc
provider: { name: aws }
resources:
  Resources:
    Events:
      Type: AWS::Kinesis::Stream
      Properties:
        ShardCount: 1
    Uploads:
      Type: AWS::S3::Bucket
`;
        const hits = parseSlsResources(tpl);
        const kinds = new Set(hits.map(h => h.kind));
        expect(kinds.has('queue')).toBe(true);
        expect(kinds.has('external')).toBe(true);
    });

    it('falls back to top-level Resources when nested form is absent', () => {
        // Some SLS configs use top-level `Resources:` directly when
        // there is no other configuration block.
        const tpl = `
Resources:
  Topic:
    Type: AWS::SNS::Topic
`;
        const hits = parseSlsResources(tpl);
        expect(hits.find(h => h.type === 'AWS::SNS::Topic')?.kind).toBe('queue');
    });

    it('returns [] when no resources block is present', () => {
        const tpl = `
service: empty
provider: { name: aws }
functions: {}
`;
        expect(parseSlsResources(tpl)).toEqual([]);
    });

    it('returns [] for malformed YAML', () => {
        expect(parseSlsResources(':::not yaml:::')).toEqual([]);
        expect(parseSlsResources('')).toEqual([]);
    });

    it('isSlsLikely recognises canonical filename + service+provider shape', () => {
        expect(isSlsLikely('apps/svc/serverless.yml')).toBe(true);
        expect(isSlsLikely('apps/svc/serverless.yaml')).toBe(true);
        expect(
            isSlsLikely('other.yaml', 'service: foo\nprovider:\n  name: aws\n'),
        ).toBe(true);
        expect(isSlsLikely('other.yaml', 'service: foo')).toBe(false);
        expect(isSlsLikely('other.yaml')).toBe(false);
    });

    it('dedupes via the shared *.ToInfraServices helper', () => {
        const tpl = `
service: svc
provider: { name: aws }
resources:
  Resources:
    A: { Type: AWS::DynamoDB::Table }
    B: { Type: AWS::DynamoDB::Table }
    C: { Type: AWS::SQS::Queue }
`;
        const hits = parseSlsResources(tpl);
        const infra = slsResourcesToInfraServices(hits, 'service:main');
        expect(infra).toHaveLength(2); // table + queue
        expect(infra.find(s => s.kind === 'database')?.name).toBe('DynamoDB Table');
        expect(infra.find(s => s.kind === 'queue')?.name).toBe('SQS Queue');
    });
});
