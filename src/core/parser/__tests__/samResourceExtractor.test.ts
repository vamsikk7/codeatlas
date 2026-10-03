/**
 * samResourceExtractor.test.ts — UX-54b (2026-06-06).
 *
 * Verifies SAM / plain-CloudFormation YAML resource declarations lift
 * into the same `InfrastructureService` shape the CDK extractor emits,
 * so a single AWS topology renders identically across IaC flavors.
 */
import { describe, it, expect } from 'vitest';
import {
    parseSamResources,
    samResourcesToInfraServices,
    isSamLikely,
} from '../samResourceExtractor';

describe('samResourceExtractor — UX-54b', () => {
    it('detects a Kinesis Stream', () => {
        const tpl = `
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  KinesisStream:
    Type: AWS::Kinesis::Stream
    Properties:
      ShardCount: 1
`;
        const hits = parseSamResources(tpl);
        expect(hits.find(h => h.type === 'AWS::Kinesis::Stream')).toMatchObject({
            logicalId: 'KinesisStream',
            name: 'Kinesis Stream',
            kind: 'queue',
        });
    });

    it('detects DynamoDB / SQS / SNS / S3 / Cognito + multiple gateway types', () => {
        const tpl = `
Resources:
  ItemsTable:
    Type: AWS::DynamoDB::Table
  TasksQueue:
    Type: AWS::SQS::Queue
  EventsTopic:
    Type: AWS::SNS::Topic
  AssetsBucket:
    Type: AWS::S3::Bucket
  UserPool:
    Type: AWS::Cognito::UserPool
  RestApi:
    Type: AWS::ApiGateway::RestApi
  HttpApi:
    Type: AWS::ApiGatewayV2::Api
  SamRest:
    Type: AWS::Serverless::Api
  SamHttp:
    Type: AWS::Serverless::HttpApi
`;
        const hits = parseSamResources(tpl);
        const kinds = new Set(hits.map(h => h.kind));
        expect(kinds.has('database')).toBe(true);   // DynamoDB
        expect(kinds.has('queue')).toBe(true);      // SQS / SNS
        expect(kinds.has('external')).toBe(true);   // S3 / Cognito / gateways
        expect(hits.find(h => h.type === 'AWS::DynamoDB::Table')?.name).toBe('DynamoDB Table');
        expect(hits.find(h => h.type === 'AWS::SQS::Queue')?.name).toBe('SQS Queue');
        expect(hits.find(h => h.type === 'AWS::SNS::Topic')?.name).toBe('SNS Topic');
        expect(hits.find(h => h.type === 'AWS::S3::Bucket')?.name).toBe('S3 Bucket');
        expect(hits.find(h => h.type === 'AWS::Cognito::UserPool')?.name).toBe('Cognito UserPool');
        expect(hits.find(h => h.type === 'AWS::ApiGateway::RestApi')?.name).toBe('API Gateway (REST)');
        expect(hits.find(h => h.type === 'AWS::ApiGatewayV2::Api')?.name).toBe('API Gateway (HTTP)');
        expect(hits.find(h => h.type === 'AWS::Serverless::Api')?.name).toBe('API Gateway (REST)');
        expect(hits.find(h => h.type === 'AWS::Serverless::HttpApi')?.name).toBe('API Gateway (HTTP)');
    });

    it('does NOT emit Lambda Function (host service, not a dep)', () => {
        const tpl = `
Resources:
  Handler:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
`;
        expect(parseSamResources(tpl)).toHaveLength(0);
    });

    it('survives CFN intrinsic-function tags (!Ref / !Sub / !GetAtt)', () => {
        // The CFN-tag-aware YAML schema treats `!Ref` as a tag, not a
        // syntax error — without that schema this template fails to
        // parse and the extractor returns 0 hits.
        const tpl = `
Resources:
  Q:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub "\${AWS::StackName}-tasks"
      VisibilityTimeout: 30
  T:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Ref ServicePrefix
`;
        const hits = parseSamResources(tpl);
        expect(hits.map(h => h.type)).toEqual(['AWS::SQS::Queue', 'AWS::DynamoDB::Table']);
    });

    it('returns [] for malformed YAML without throwing', () => {
        expect(parseSamResources(':::not yaml:::')).toEqual([]);
        expect(parseSamResources('')).toEqual([]);
        expect(parseSamResources('Resources: not-a-map')).toEqual([]);
    });

    it('dedupes multiple resources of the same kind in `*.ToInfraServices`', () => {
        const tpl = `
Resources:
  ItemsTable: { Type: AWS::DynamoDB::Table }
  UsersTable: { Type: AWS::DynamoDB::Table }
  TasksQueue: { Type: AWS::SQS::Queue }
`;
        const hits = parseSamResources(tpl);
        expect(hits).toHaveLength(3);
        const infra = samResourcesToInfraServices(hits, 'service:main');
        expect(infra).toHaveLength(2); // table + queue, deduped
        const tail = infra.find(s => s.id === 'infra:table');
        expect(tail?.consumedBy).toEqual(['service:main']);
    });

    it('isSamLikely matches canonical filename and Transform tag', () => {
        expect(isSamLikely('apps/svc/template.yaml')).toBe(true);
        expect(isSamLikely('apps/svc/template.yml')).toBe(true);
        expect(isSamLikely('other.yaml', 'Transform: AWS::Serverless-2016-10-31')).toBe(true);
        expect(isSamLikely('other.yaml', 'service: api')).toBe(false);
        expect(isSamLikely('other.yaml')).toBe(false);
    });
});
