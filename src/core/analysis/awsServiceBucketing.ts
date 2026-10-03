/**
 * awsServiceBucketing.ts — UX-27 (2026-06-05).
 *
 * Serverless-patterns-style monorepos contain hundreds of small
 * sample apps, each named after the AWS services it integrates
 * (`APIGateway-SQS-ReceiveMessages`, `eventbridge-pipes-sqs-to-multiple-sqs`,
 * `lambda-powertools-secretsmanager-cdk`, …). Rendering one L1 card
 * per pattern produces a 796-card system-design diagram that's
 * useless to navigate.
 *
 * This module extracts the AWS services-of-interest from each service
 * name (a `ServiceRecord.name` from the snapshot) and groups services
 * by AWS-service tag. The L1 builder uses these buckets when the
 * service count exceeds a threshold, rendering one node per AWS
 * service instead of one per pattern.
 *
 * Design notes:
 *   - Tokenisation is case-insensitive and dash/underscore-tolerant.
 *   - The registry is curated (no auto-tagging of unrelated words).
 *   - A pattern can land in multiple buckets — `lambda-sqs-eb` shows up
 *     under Lambda, SQS, AND EventBridge.
 *   - Patterns with no recognised service go to `__uncategorized__`.
 */

export interface AwsServiceDescriptor {
    id: string;
    label: string;
    /** Regex that matches the service token in a kebab/camel name. */
    tokenPattern: RegExp;
}

export const AWS_SERVICE_REGISTRY: AwsServiceDescriptor[] = [
    { id: 'apigateway',    label: 'API Gateway',        tokenPattern: /\b(?:apigateway|apigw|api-gateway)\b/i },
    { id: 'lambda',        label: 'Lambda',              tokenPattern: /\blambda\b/i },
    { id: 'sqs',           label: 'SQS',                 tokenPattern: /\bsqs\b/i },
    { id: 'sns',           label: 'SNS',                 tokenPattern: /\bsns\b/i },
    { id: 'eventbridge',   label: 'EventBridge',         tokenPattern: /\b(?:eventbridge|event-bridge|eb)\b/i },
    { id: 'dynamodb',      label: 'DynamoDB',            tokenPattern: /\b(?:dynamodb|ddb)\b/i },
    { id: 's3',            label: 'S3',                  tokenPattern: /\bs3\b/i },
    { id: 'kinesis',       label: 'Kinesis',             tokenPattern: /\bkinesis\b/i },
    { id: 'stepfunctions', label: 'Step Functions',      tokenPattern: /\b(?:stepfunctions|step-functions|sfn)\b/i },
    { id: 'cognito',       label: 'Cognito',             tokenPattern: /\bcognito\b/i },
    { id: 'cloudfront',    label: 'CloudFront',          tokenPattern: /\bcloudfront\b/i },
    { id: 'cloudwatch',    label: 'CloudWatch',          tokenPattern: /\b(?:cloudwatch|cw)\b/i },
    { id: 'iam',           label: 'IAM',                 tokenPattern: /\biam\b/i },
    { id: 'rds',           label: 'RDS',                 tokenPattern: /\brds\b/i },
    { id: 'aurora',        label: 'Aurora',              tokenPattern: /\baurora\b/i },
    { id: 'msk',           label: 'MSK (Kafka)',         tokenPattern: /\bmsk\b/i },
    { id: 'ecs',           label: 'ECS',                 tokenPattern: /\becs\b/i },
    { id: 'eks',           label: 'EKS',                 tokenPattern: /\beks\b/i },
    { id: 'fargate',       label: 'Fargate',             tokenPattern: /\bfargate\b/i },
    { id: 'appsync',       label: 'AppSync',             tokenPattern: /\bappsync\b/i },
    { id: 'amplify',       label: 'Amplify',             tokenPattern: /\bamplify\b/i },
    { id: 'secretsmanager', label: 'Secrets Manager',    tokenPattern: /\b(?:secretsmanager|secrets-manager)\b/i },
    { id: 'systems-manager', label: 'Systems Manager',   tokenPattern: /\b(?:ssm|systems-manager|systemsmanager)\b/i },
    { id: 'glue',          label: 'Glue',                tokenPattern: /\bglue\b/i },
    { id: 'athena',        label: 'Athena',              tokenPattern: /\bathena\b/i },
    { id: 'firehose',      label: 'Firehose',            tokenPattern: /\bfirehose\b/i },
    { id: 'opensearch',    label: 'OpenSearch',          tokenPattern: /\bopensearch\b/i },
    { id: 'elasticache',   label: 'ElastiCache',         tokenPattern: /\belasticache\b/i },
    { id: 'redshift',      label: 'Redshift',            tokenPattern: /\bredshift\b/i },
    { id: 'route53',       label: 'Route 53',            tokenPattern: /\broute53\b/i },
    { id: 'vpc',           label: 'VPC',                 tokenPattern: /\bvpc\b/i },
];

/**
 * Normalize a service name for regex matching. Replaces all common
 * separators (-, _, .) with single spaces so `\b` matches the token
 * boundaries on both sides.
 */
function tokenize(name: string): string {
    return name.replace(/[-_./]+/g, ' ').toLowerCase();
}

/**
 * Pure: returns the list of AWS service ids matched in `name`. Each
 * service appears at most once even if it occurs multiple times in
 * the name. Returns `[]` for names with no recognized service.
 */
export function extractAwsServicesFromName(name: string): string[] {
    if (!name) return [];
    const tokenized = tokenize(name);
    const out: string[] = [];
    for (const svc of AWS_SERVICE_REGISTRY) {
        if (svc.tokenPattern.test(tokenized) && !out.includes(svc.id)) {
            out.push(svc.id);
        }
    }
    return out;
}

export interface ServiceLike {
    id: string;
    name: string;
}

export interface AwsServiceBucket {
    awsService: string;
    label: string;
    members: ServiceLike[];
}

/**
 * Group services by detected AWS-service tag. Each service can appear
 * in multiple buckets (one per detected service). Services with no
 * detected AWS service land in an `__uncategorized__` bucket. Output
 * is sorted by member count descending so the most-frequent service
 * leads in the L1 layout.
 */
export function bucketServicesByAwsService(services: ServiceLike[]): AwsServiceBucket[] {
    if (services.length === 0) return [];
    const byId = new Map<string, AwsServiceBucket>();
    const ensureBucket = (id: string, label: string): AwsServiceBucket => {
        let b = byId.get(id);
        if (!b) {
            b = { awsService: id, label, members: [] };
            byId.set(id, b);
        }
        return b;
    };
    for (const svc of services) {
        const matched = extractAwsServicesFromName(svc.name);
        if (matched.length === 0) {
            ensureBucket('__uncategorized__', 'Other').members.push(svc);
            continue;
        }
        for (const m of matched) {
            const desc = AWS_SERVICE_REGISTRY.find((d) => d.id === m);
            ensureBucket(m, desc?.label ?? m).members.push(svc);
        }
    }
    return [...byId.values()].sort((a, b) => b.members.length - a.members.length);
}
