/**
 * infra/index.ts — Issue #705 registry + dispatcher.
 *
 * Per the issue's plugin-architecture convention (mirroring the
 * frameworks + mobile registries landed in #703): each infra parser
 * exports a `{ canParse, parse }` pair. The dispatcher walks the list
 * in registration order; the first one whose `canParse(filePath)`
 * returns true wins. Multiple records per file are flattened into the
 * returned array.
 *
 * Phase 1 shipped Dockerfile + Terraform + Markdown. Phase 2 adds
 * Kubernetes, OpenAPI/Swagger, and Protocol Buffers (.proto). GraphQL
 * SDL lives in `frameworkDetector.ts` for now (HTTP-adjacent shape).
 */

import type { InfraRecord } from '../../graph/graphTypes';
import { canParseDockerfile, parseDockerfile } from './dockerfile';
import { canParseTerraform, parseTerraform } from './terraform';
import { canParseMarkdown, parseMarkdown } from './markdown';
import { canParseK8s, parseK8s } from './k8s';
import { canParseOpenApi, parseOpenApi } from './openapi';
import { canParseProto, parseProto } from './protobuf';
import { canParseGraphql, parseGraphql } from './graphql';

export interface InfraParser {
    id: string;
    canParse(filePath: string): boolean;
    parse(filePath: string, source: string): InfraRecord[];
}

const PARSERS: InfraParser[] = [
    { id: 'dockerfile', canParse: canParseDockerfile, parse: parseDockerfile },
    { id: 'terraform', canParse: canParseTerraform, parse: parseTerraform },
    // OpenAPI must precede `k8s` since both can claim a `.yaml` file —
    // openapi.canParse is narrower (only `openapi.yaml`, `swagger.yaml`,
    // `*.openapi.yaml`, etc.), so the narrow matcher gets first pick.
    { id: 'openapi', canParse: canParseOpenApi, parse: parseOpenApi },
    { id: 'k8s', canParse: canParseK8s, parse: parseK8s },
    { id: 'protobuf', canParse: canParseProto, parse: parseProto },
    { id: 'graphql', canParse: canParseGraphql, parse: parseGraphql },
    { id: 'markdown', canParse: canParseMarkdown, parse: parseMarkdown },
];

/**
 * Parse one file's infrastructure-as-code records, or return [] when no
 * registered parser claims the path. The caller (e.g. the workspace
 * scanner) typically wraps this in a try/catch — malformed infra files
 * should never break the overall scan.
 */
export function parseInfraFile(filePath: string, source: string): InfraRecord[] {
    for (const p of PARSERS) {
        if (p.canParse(filePath)) {
            try {
                return p.parse(filePath, source);
            } catch {
                return [];
            }
        }
    }
    return [];
}

export function listInfraParsers(): readonly InfraParser[] {
    return PARSERS;
}

export { canParseDockerfile, parseDockerfile } from './dockerfile';
export { canParseTerraform, parseTerraform } from './terraform';
export { canParseK8s, parseK8s } from './k8s';
export { canParseOpenApi, parseOpenApi } from './openapi';
export { canParseProto, parseProto } from './protobuf';
export { canParseGraphql, parseGraphql } from './graphql';
