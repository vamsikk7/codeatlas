/**
 * awsServiceBucketing.test.ts — UX-27 (2026-06-05).
 */

import { describe, it, expect } from 'vitest';
import {
    extractAwsServicesFromName,
    bucketServicesByAwsService,
    AWS_SERVICE_REGISTRY,
} from '../awsServiceBucketing';

describe('extractAwsServicesFromName', () => {
    it('finds apigw, lambda from APIGateway-SQS-ReceiveMessages style', () => {
        const services = extractAwsServicesFromName('APIGateway-SQS-ReceiveMessages');
        expect(services).toEqual(expect.arrayContaining(['apigateway', 'sqs']));
    });

    it('finds eventbridge, sqs from kebab-case', () => {
        const services = extractAwsServicesFromName('eventbridge-pipes-sqs-to-multiple-sqs');
        expect(services).toEqual(expect.arrayContaining(['eventbridge', 'sqs']));
    });

    it('finds lambda + secretsmanager from compound name', () => {
        const services = extractAwsServicesFromName('lambda-powertools-secretsmanager-cdk');
        expect(services).toEqual(expect.arrayContaining(['lambda', 'secretsmanager']));
    });

    it('finds msk from msk-lambda-schema-avro-java-sam', () => {
        const services = extractAwsServicesFromName('msk-lambda-schema-avro-java-sam');
        expect(services).toEqual(expect.arrayContaining(['msk', 'lambda']));
    });

    it('handles all the lower-case major services individually', () => {
        for (const svc of ['s3', 'dynamodb', 'kinesis', 'stepfunctions', 'cognito', 'cloudfront']) {
            const found = extractAwsServicesFromName(`my-${svc}-pattern`);
            expect(found, `${svc} should be found in 'my-${svc}-pattern'`).toContain(svc);
        }
    });

    it('returns empty array on non-AWS-pattern names', () => {
        expect(extractAwsServicesFromName('random-repo-name')).toEqual([]);
        expect(extractAwsServicesFromName('frontend-app')).toEqual([]);
    });

    it('handles case-insensitive matching', () => {
        const services = extractAwsServicesFromName('APIGateway-Lambda-DynamoDB');
        expect(services).toEqual(expect.arrayContaining(['apigateway', 'lambda', 'dynamodb']));
    });

    it('does not return duplicates when a service appears twice', () => {
        const services = extractAwsServicesFromName('sqs-to-sqs-via-eventbridge');
        const count = services.filter((s) => s === 'sqs').length;
        expect(count).toBe(1);
    });
});

describe('AWS_SERVICE_REGISTRY', () => {
    it('contains the major service families', () => {
        const ids = AWS_SERVICE_REGISTRY.map((r) => r.id);
        for (const major of ['lambda', 'apigateway', 'sqs', 'sns', 'eventbridge', 'dynamodb', 's3', 'kinesis', 'stepfunctions', 'cognito']) {
            expect(ids).toContain(major);
        }
    });
    it('every entry has a display label', () => {
        for (const r of AWS_SERVICE_REGISTRY) {
            expect(r.label).toBeTruthy();
        }
    });
});

describe('bucketServicesByAwsService', () => {
    it('groups services that share an AWS service tag', () => {
        const services = [
            { id: 'service:apigw-sqs-1', name: 'apigw-sqs-1' },
            { id: 'service:apigw-sqs-2', name: 'apigw-sqs-2' },
            { id: 'service:lambda-only', name: 'lambda-only' },
            { id: 'service:eventbridge-flow', name: 'eventbridge-flow' },
        ];
        const buckets = bucketServicesByAwsService(services);
        // apigateway should hold the first two; sqs should also hold them; lambda + eventbridge solo.
        const ap = buckets.find((b) => b.awsService === 'apigateway');
        expect(ap?.members.length).toBe(2);
        const sqs = buckets.find((b) => b.awsService === 'sqs');
        expect(sqs?.members.length).toBe(2);
        const lambda = buckets.find((b) => b.awsService === 'lambda');
        expect(lambda?.members.length).toBe(1);
        const eb = buckets.find((b) => b.awsService === 'eventbridge');
        expect(eb?.members.length).toBe(1);
    });

    it('returns empty array when no input services', () => {
        expect(bucketServicesByAwsService([])).toEqual([]);
    });

    it('handles services with no recognizable AWS service in name (uncategorized bucket)', () => {
        const services = [
            { id: 'service:random', name: 'random-app' },
            { id: 'service:other', name: 'other-thing' },
            { id: 'service:lambda-fn', name: 'lambda-fn' },
        ];
        const buckets = bucketServicesByAwsService(services);
        const lambda = buckets.find((b) => b.awsService === 'lambda');
        expect(lambda?.members.length).toBe(1);
        const uncategorized = buckets.find((b) => b.awsService === '__uncategorized__');
        expect(uncategorized?.members.length).toBe(2);
    });

    it('sorts buckets by member count descending for L1 prominence', () => {
        const services = [
            { id: 's:a', name: 'lambda-a' },
            { id: 's:b', name: 'lambda-b' },
            { id: 's:c', name: 'lambda-c' },
            { id: 's:d', name: 'sqs-d' },
        ];
        const buckets = bucketServicesByAwsService(services);
        expect(buckets[0].awsService).toBe('lambda');
        expect(buckets[0].members.length).toBe(3);
    });
});
