/**
 * cdkResourceExtractor.ts — UX-54a (2026-06-06)
 *
 * Walks CDK source files (TypeScript / Python / Java) for declared AWS
 * resource constructs and emits `InfrastructureService` records so the
 * L1 microservice graph can render them as 🌐 / 🗄️ / 📬 infra nodes
 * with `consumes` edges from the host service.
 *
 * Sibling to `cdkConstructExtractor.ts` (route extraction) — same
 * detection gate (`isCdkLikely`) but different output type.
 *
 * Recognised construct types (a curated set covering the dominant
 * serverless-patterns shapes):
 *   - `Stream` (aws-kinesis)        → queue
 *   - `Queue` (aws-sqs)             → queue
 *   - `Topic` (aws-sns)             → queue
 *   - `Table` (aws-dynamodb)        → database
 *   - `Bucket` (aws-s3)             → external
 *   - `UserPool` (aws-cognito)      → external
 *   - `RestApi` / `HttpApi` (aws-apigateway*) → external (gateway)
 *   - `Function` (aws-lambda)       — intentionally omitted; Lambda is
 *     the host service, not an external dep.
 *
 * Detection uses regex over `new <Type>(...)` declarations. The Python
 * snake_case form (`aws_kinesis.Stream(...)`) and Java import-aware
 * forms (`Stream.Builder.create(...)`) are also recognised for the
 * common cases.
 */

import { isCdkLikely } from './cdkConstructExtractor';
import type { InfrastructureService } from '../graph/graphTypes';

/** Mapping table — keep narrow so we don't over-detect. */
const CONSTRUCT_RULES: Array<{
    /** Construct class name as it appears in `new <X>(...)`. */
    type: string;
    /** Display name for the L1 node. */
    name: string;
    /** L1 kind for icon + grouping. */
    kind: InfrastructureService['kind'];
}> = [
    { type: 'Stream',   name: 'Kinesis Stream',   kind: 'queue' },
    { type: 'Queue',    name: 'SQS Queue',        kind: 'queue' },
    { type: 'Topic',    name: 'SNS Topic',        kind: 'queue' },
    { type: 'Table',    name: 'DynamoDB Table',   kind: 'database' },
    { type: 'Bucket',   name: 'S3 Bucket',        kind: 'external' },
    { type: 'UserPool', name: 'Cognito UserPool', kind: 'external' },
    { type: 'RestApi',  name: 'API Gateway (REST)', kind: 'external' },
    { type: 'HttpApi',  name: 'API Gateway (HTTP)', kind: 'external' },
];

export interface CdkResourceHit {
    /** Construct class name found in source (`Stream`, `Table`, …). */
    type: string;
    /** Display name suitable for an L1 node label. */
    name: string;
    /** L1 grouping. */
    kind: InfrastructureService['kind'];
    /** Source byte offset of the `new <Type>(` match. */
    offset: number;
    /** Optional local variable name (when the declaration assigns to one). */
    localName?: string;
}

/**
 * Parse the source for CDK resource declarations. Returns empty when
 * the file doesn't look like CDK. Pure / synchronous / cheap (small
 * regex scan); safe to call from the IaC scanner alongside the route
 * extractor.
 */
export function parseCdkResources(source: string): CdkResourceHit[] {
    if (!isCdkLikely(source)) return [];

    const out: CdkResourceHit[] = [];
    const seen = new Set<string>(); // dedupe by (type, offset)

    for (const rule of CONSTRUCT_RULES) {
        // Match patterns:
        //   new Stream(this, 'KinesisStream', { … })
        //   new aws_kinesis.Stream(this, 'KinesisStream')
        //   const kinesis = new Stream(this, 'KinesisStream')
        //   <indent>kinesis = aws_kinesis.Stream(self, 'KinesisStream')   (Python)
        //   new Stream.Builder.create(...)                                  (Java)
        const escType = rule.type;
        const ts = new RegExp(
            `(?:(?:const|let|var)\\s+(\\w+)\\s*=\\s*|\\b(\\w+)\\s*=\\s*)?` + // optional LHS
            `new\\s+(?:\\w+\\s*\\.\\s*)*${escType}\\s*\\(`,
            'g',
        );
        let m: RegExpExecArray | null;
        while ((m = ts.exec(source)) !== null) {
            const key = `${rule.type}:${m.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                type: rule.type,
                name: rule.name,
                kind: rule.kind,
                offset: m.index,
                localName: m[1] ?? m[2],
            });
        }
        // Python: `aws_kinesis.Stream(self, 'X')` or `apigw.RestApi(...)`
        const py = new RegExp(`\\b\\w+\\s*\\.\\s*${escType}\\s*\\(\\s*self\\b`, 'g');
        while ((m = py.exec(source)) !== null) {
            const key = `${rule.type}:py:${m.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                type: rule.type,
                name: rule.name,
                kind: rule.kind,
                offset: m.index,
            });
        }
        // Java: `Stream.Builder.create(this, "X")`
        const java = new RegExp(`\\b${escType}\\s*\\.\\s*Builder\\s*\\.\\s*create\\s*\\(`, 'g');
        while ((m = java.exec(source)) !== null) {
            const key = `${rule.type}:java:${m.index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                type: rule.type,
                name: rule.name,
                kind: rule.kind,
                offset: m.index,
            });
        }
    }

    return out;
}

/**
 * Convenience: turn the hits into `InfrastructureService` records keyed
 * by `infra:<lower-cased-type>` so the L1 graph builder can dedupe
 * within a workspace.
 *
 * `hostServiceId` becomes the (single) entry in `consumedBy`.
 */
export function cdkResourcesToInfraServices(
    hits: CdkResourceHit[],
    hostServiceId: string,
): InfrastructureService[] {
    const byKey = new Map<string, InfrastructureService>();
    for (const h of hits) {
        const id = `infra:${h.type.toLowerCase()}`;
        const existing = byKey.get(id);
        if (existing) {
            if (!existing.consumedBy.includes(hostServiceId)) existing.consumedBy.push(hostServiceId);
            continue;
        }
        byKey.set(id, {
            id,
            name: h.name,
            kind: h.kind,
            consumedBy: [hostServiceId],
        });
    }
    return [...byKey.values()];
}
