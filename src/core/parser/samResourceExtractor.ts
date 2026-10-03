/**
 * samResourceExtractor.ts — UX-54b (2026-06-06)
 *
 * Walks a SAM (`template.yaml`) / generic CloudFormation YAML for
 * AWS resource declarations and emits `InfrastructureService` records
 * so the L1 microservice graph can surface them with `consumes` /
 * `publishes` / `uses` edges from the host service.
 *
 * Sibling to `samRouteExtractor.ts` (route extraction) — same template
 * format, different output type. Recognises both:
 *   - SAM-native resource types (`AWS::Serverless::*`)
 *   - Plain CloudFormation types (`AWS::Kinesis::Stream`,
 *     `AWS::DynamoDB::Table`, `AWS::SQS::Queue`, `AWS::SNS::Topic`,
 *     `AWS::S3::Bucket`, `AWS::Cognito::UserPool`).
 *
 * Lambda Functions (`AWS::Serverless::Function`, `AWS::Lambda::Function`)
 * are intentionally omitted — Lambda IS the host service that runs the
 * code, not an external dependency.
 */

import * as yaml from 'js-yaml';
import type { InfrastructureService } from '../graph/graphTypes';

/**
 * CloudFormation type → infra display + kind. Match the CDK extractor
 * mapping so a single AWS topology renders identically whether it's
 * declared via CDK constructs or plain CFN/SAM YAML.
 */
const TYPE_RULES: Record<string, { name: string; kind: InfrastructureService['kind'] }> = {
    'AWS::Kinesis::Stream':       { name: 'Kinesis Stream',     kind: 'queue' },
    'AWS::SQS::Queue':            { name: 'SQS Queue',          kind: 'queue' },
    'AWS::SNS::Topic':            { name: 'SNS Topic',          kind: 'queue' },
    'AWS::DynamoDB::Table':       { name: 'DynamoDB Table',     kind: 'database' },
    'AWS::S3::Bucket':            { name: 'S3 Bucket',          kind: 'external' },
    'AWS::Cognito::UserPool':     { name: 'Cognito UserPool',   kind: 'external' },
    'AWS::ApiGateway::RestApi':   { name: 'API Gateway (REST)', kind: 'external' },
    'AWS::ApiGatewayV2::Api':     { name: 'API Gateway (HTTP)', kind: 'external' },
    'AWS::Serverless::Api':       { name: 'API Gateway (REST)', kind: 'external' },
    'AWS::Serverless::HttpApi':   { name: 'API Gateway (HTTP)', kind: 'external' },
};

export interface SamResourceHit {
    /** Resource logical id from the template (the YAML map key). */
    logicalId: string;
    /** Raw CloudFormation type. */
    type: string;
    /** Display name (matches CDK extractor for cross-format dedup). */
    name: string;
    /** L1 grouping. */
    kind: InfrastructureService['kind'];
}

/**
 * Same CFN-tag-tolerant YAML schema the route extractor uses, so a
 * template with `!Ref`, `!Sub`, etc. doesn't make this extractor fail
 * silently. Mirrors the construction in `samRouteExtractor.ts`.
 */
const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
    [
        'Ref', 'Sub', 'GetAtt', 'GetAZs', 'Join', 'Select', 'Split', 'FindInMap',
        'ImportValue', 'If', 'Equals', 'And', 'Or', 'Not', 'Base64', 'Cidr',
        'Transform', 'Condition', 'Length',
    ].flatMap((name) => [
        new yaml.Type(`!${name}`, { kind: 'scalar', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'sequence', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'mapping', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
    ]),
);

/**
 * Probe whether a path looks like a SAM template. Used by the IaC
 * scanner to gate this extractor — matches the route extractor's
 * heuristic.
 */
export function isSamLikely(filePath: string, content?: string): boolean {
    const base = filePath.toLowerCase();
    if (base.endsWith('template.yaml') || base.endsWith('template.yml')) return true;
    if (typeof content === 'string') {
        return /AWS::Serverless|^\s*Transform:\s*AWS::Serverless/m.test(content);
    }
    return false;
}

/**
 * Parse a SAM / CloudFormation template for declared AWS resources.
 * Returns [] for empty / malformed / non-CFN input — never throws into
 * the caller (matching the route extractor's failure contract).
 */
export function parseSamResources(yamlText: string): SamResourceHit[] {
    if (!yamlText || !yamlText.trim()) return [];

    let doc: any;
    try {
        doc = yaml.load(yamlText, { schema: CFN_SCHEMA });
    } catch {
        return [];
    }
    if (!doc || typeof doc !== 'object') return [];

    const resources = (doc as any).Resources;
    if (!resources || typeof resources !== 'object') return [];

    const hits: SamResourceHit[] = [];
    for (const [logicalId, raw] of Object.entries(resources)) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as any;
        const type = String(r.Type ?? '');
        const rule = TYPE_RULES[type];
        if (!rule) continue;
        hits.push({ logicalId, type, name: rule.name, kind: rule.kind });
    }
    return hits;
}

/**
 * Convenience: turn the hits into `InfrastructureService` records keyed
 * by `infra:<type-tail>` (e.g. `infra:stream`). Dedupes within a single
 * template — many real templates declare multiple Tables / Queues, but
 * one infra node per kind keeps L1 readable.
 *
 * `hostServiceId` becomes the (single) entry in `consumedBy`.
 */
export function samResourcesToInfraServices(
    hits: SamResourceHit[],
    hostServiceId: string,
): InfrastructureService[] {
    const byKey = new Map<string, InfrastructureService>();
    for (const h of hits) {
        const tail = h.type.split('::').pop() ?? h.type;
        const id = `infra:${tail.toLowerCase()}`;
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
