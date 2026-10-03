/**
 * cdkResourceExtractor.test.ts — UX-54a (2026-06-06)
 *
 * Verifies CDK resource declarations (Kinesis Stream, DynamoDB Table,
 * SQS Queue, S3 Bucket, …) lift into `InfrastructureService` records
 * with the right `kind` so the L1 microservice graph can render them.
 */
import { describe, it, expect } from 'vitest';
import { parseCdkResources, cdkResourcesToInfraServices } from '../cdkResourceExtractor';

describe('cdkResourceExtractor — UX-54a', () => {
    it('detects a Kinesis Stream declaration in TS', () => {
        const src = `
            import { Stream } from 'aws-cdk-lib/aws-kinesis';
            const kinesis = new Stream(this, 'KinesisStream', { streamName: 'temp' });
        `;
        const hits = parseCdkResources(src);
        const stream = hits.find(h => h.type === 'Stream');
        expect(stream).toBeDefined();
        expect(stream!.kind).toBe('queue');
        expect(stream!.name).toBe('Kinesis Stream');
        expect(stream!.localName).toBe('kinesis');
    });

    it('detects a DynamoDB Table declaration in TS', () => {
        const src = `
            import { Table } from 'aws-cdk-lib/aws-dynamodb';
            const items = new Table(this, 'Items', { tableName: 'items' });
        `;
        const hits = parseCdkResources(src);
        const table = hits.find(h => h.type === 'Table');
        expect(table).toBeDefined();
        expect(table!.kind).toBe('database');
        expect(table!.name).toBe('DynamoDB Table');
    });

    it('detects an SQS Queue declaration', () => {
        const src = `
            import { Queue } from 'aws-cdk-lib/aws-sqs';
            const q = new Queue(this, 'Tasks');
        `;
        const hits = parseCdkResources(src);
        const queue = hits.find(h => h.type === 'Queue');
        expect(queue?.kind).toBe('queue');
        expect(queue?.name).toBe('SQS Queue');
    });

    it('detects an S3 Bucket', () => {
        const src = `
            import { Bucket } from 'aws-cdk-lib/aws-s3';
            const assets = new Bucket(this, 'Assets');
        `;
        const hits = parseCdkResources(src);
        const bucket = hits.find(h => h.type === 'Bucket');
        expect(bucket?.kind).toBe('external');
        expect(bucket?.name).toBe('S3 Bucket');
    });

    it('detects RestApi gateway', () => {
        const src = `
            import { RestApi } from 'aws-cdk-lib/aws-apigateway';
            const api = new RestApi(this, 'PublicApi');
        `;
        const hits = parseCdkResources(src);
        expect(hits.find(h => h.type === 'RestApi')?.name).toBe('API Gateway (REST)');
    });

    it('does NOT match construct names in non-CDK source', () => {
        const src = `
            // No aws-cdk-lib import; just happens to use 'Stream' as a class name.
            class Stream { constructor() {} }
            const s = new Stream();
        `;
        expect(parseCdkResources(src)).toHaveLength(0);
    });

    it('handles namespaced TS form (aws_kinesis.Stream)', () => {
        const src = `
            import * as kinesis from 'aws-cdk-lib/aws-kinesis';
            const s = new kinesis.Stream(this, 'S');
        `;
        const hits = parseCdkResources(src);
        expect(hits.find(h => h.type === 'Stream')?.kind).toBe('queue');
    });

    it('handles Python form (aws_kinesis.Stream(self, ...))', () => {
        const src = `
            from aws_cdk import aws_kinesis as kinesis
            class MyStack(Stack):
                def __init__(self):
                    s = kinesis.Stream(self, 'S')
        `;
        const hits = parseCdkResources(src);
        expect(hits.find(h => h.type === 'Stream')).toBeDefined();
    });

    it('handles Java builder form (Stream.Builder.create(...))', () => {
        const src = `
            import software.amazon.awscdk.services.kinesis.Stream;
            public class MyStack {
                public MyStack() {
                    Stream stream = Stream.Builder.create(this, "S").build();
                }
            }
        `;
        const hits = parseCdkResources(src);
        expect(hits.find(h => h.type === 'Stream')).toBeDefined();
    });

    it('dedupes multiple resources of the same type into a single InfrastructureService', () => {
        const src = `
            import { Table } from 'aws-cdk-lib/aws-dynamodb';
            const items = new Table(this, 'Items');
            const users = new Table(this, 'Users');
            const orders = new Table(this, 'Orders');
        `;
        const hits = parseCdkResources(src);
        expect(hits.filter(h => h.type === 'Table')).toHaveLength(3);
        const infra = cdkResourcesToInfraServices(hits, 'service:main');
        const table = infra.find(s => s.id === 'infra:table');
        expect(infra.filter(s => s.id === 'infra:table')).toHaveLength(1);
        expect(table?.consumedBy).toEqual(['service:main']);
    });

    it('captures multiple resource KINDS in one file', () => {
        const src = `
            import { Stream } from 'aws-cdk-lib/aws-kinesis';
            import { Table } from 'aws-cdk-lib/aws-dynamodb';
            import { Bucket } from 'aws-cdk-lib/aws-s3';
            new Stream(this, 'K');
            new Table(this, 'T');
            new Bucket(this, 'B');
        `;
        const hits = parseCdkResources(src);
        const types = new Set(hits.map(h => h.type));
        expect(types.has('Stream')).toBe(true);
        expect(types.has('Table')).toBe(true);
        expect(types.has('Bucket')).toBe(true);
        const infra = cdkResourcesToInfraServices(hits, 'service:main');
        expect(infra.length).toBe(3);
        expect(infra.find(s => s.kind === 'queue')?.name).toBe('Kinesis Stream');
        expect(infra.find(s => s.kind === 'database')?.name).toBe('DynamoDB Table');
        expect(infra.find(s => s.kind === 'external' && s.name === 'S3 Bucket')).toBeDefined();
    });

    it('does NOT emit a Function infra node (Lambda is the host service, not a dep)', () => {
        const src = `
            import { Function } from 'aws-cdk-lib/aws-lambda';
            const handler = new Function(this, 'Handler', {});
        `;
        const hits = parseCdkResources(src);
        expect(hits.find(h => h.type === 'Function')).toBeUndefined();
    });
});
