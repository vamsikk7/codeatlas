/**
 * infra/terraform.ts — Issue #705 Phase 1 Terraform parser.
 *
 * Extracts top-level `resource "<type>" "<name>" {}` and
 * `module "<name>" {}` blocks from `.tf` files. Each becomes a record
 * with the resource address (`<type>.<name>` for resources,
 * `module.<name>` for modules) as the name. Inter-resource references
 * via HCL interpolation (`${aws_iam_role.lambda_exec.arn}` →
 * dependency on `aws_iam_role.lambda_exec`) populate the `dependencies`
 * array.
 *
 * Regex-based (no full HCL parser) — Terraform's grammar is heavier
 * than we need for the L1 architecture view. We pick up:
 *   - The top-level `resource "<type>" "<name>" {` / `module "<name>" {`
 *     openings (one record per block).
 *   - References to other resource addresses inside the block body
 *     (`<type>.<name>` patterns, including `module.<name>.<output>`).
 *
 * `data "<type>" "<name>" {}` data sources are NOT emitted as records —
 * they're read-only inputs, not infrastructure intent — but their
 * addresses DO show up as resolved dependencies of resources that
 * consume them.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

export function canParseTerraform(filePath: string): boolean {
    return /\.tf(\.json)?$/i.test(filePath);
}

interface BlockOpener {
    kind: 'resource' | 'module' | 'data';
    type?: string; // resource type for resources + data sources; undefined for modules
    name: string;  // resource name / module name / data source name
    lineIndex: number;
}

export function parseTerraform(filePath: string, source: string): InfraRecord[] {
    const lines = source.split('\n');
    // Pass 1 — discover block openers. Track every block so we can match
    // dependency references against ALL known addresses (incl. data).
    const blocks = discoverBlocks(lines);
    if (blocks.length === 0) return [];

    // Build an address → record-id resolution map for dependency edges.
    const addressToId = new Map<string, string>();
    for (const b of blocks) {
        if (b.kind === 'resource' && b.type) {
            addressToId.set(`${b.type}.${b.name}`, `infra:terraform-resource:${filePath}::${b.type}.${b.name}`);
        } else if (b.kind === 'module') {
            addressToId.set(`module.${b.name}`, `infra:terraform-module:${filePath}::${b.name}`);
        } else if (b.kind === 'data' && b.type) {
            addressToId.set(`data.${b.type}.${b.name}`, `data.${b.type}.${b.name}`);
        }
    }

    // Pass 2 — per-block body scan for inter-block references.
    const records: InfraRecord[] = [];
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.kind === 'data') continue; // data sources don't emit records
        const bodyStart = b.lineIndex + 1;
        const bodyEnd = i + 1 < blocks.length ? blocks[i + 1].lineIndex : lines.length;

        const refs = findReferences(lines.slice(bodyStart, bodyEnd).join('\n'), addressToId);

        const isResource = b.kind === 'resource';
        const id = isResource
            ? `infra:terraform-resource:${filePath}::${b.type}.${b.name}`
            : `infra:terraform-module:${filePath}::${b.name}`;
        const name = isResource ? `${b.type}.${b.name}` : `module.${b.name}`;
        const anchor: Anchor = {
            filePath,
            symbol: name,
            span: { start: charOffsetOfLine(lines, b.lineIndex), end: charOffsetOfLine(lines, b.lineIndex + 1) },
        };

        // Filter self-references (an interpolated reference that happens
        // to land back on the declaring resource — common in policy /
        // description fields) so we don't show a self-loop in the L1
        // graph. When the post-filter set is empty, omit the field
        // entirely (avoids `dependencies: []` polluting JSON dumps).
        const filteredDeps = refs.size > 0 ? [...refs].filter(r => r !== id) : [];

        records.push({
            id,
            kind: isResource ? 'terraform-resource' : 'terraform-module',
            name,
            filePath,
            anchor,
            dependencies: filteredDeps.length > 0 ? filteredDeps : undefined,
            meta: isResource ? { provider: providerFor(b.type ?? ''), resourceType: b.type } : { moduleName: b.name },
        });
    }

    return records;
}

function discoverBlocks(lines: string[]): BlockOpener[] {
    const out: BlockOpener[] = [];
    // Trailing `\s*\{?` allows the opening brace either on this line
    // OR on a subsequent one. `[\s\S]*$` permits `{}` and `{\s*}`
    // (empty block declared on a single line) without matching the
    // opener's body — we only need the line position.
    const resourceRe = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*[\s\S]*$/;
    const moduleRe = /^\s*module\s+"([^"]+)"\s*[\s\S]*$/;
    const dataRe = /^\s*data\s+"([^"]+)"\s+"([^"]+)"\s*[\s\S]*$/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m: RegExpExecArray | null;
        if ((m = resourceRe.exec(line))) {
            out.push({ kind: 'resource', type: m[1], name: m[2], lineIndex: i });
        } else if ((m = moduleRe.exec(line))) {
            out.push({ kind: 'module', name: m[1], lineIndex: i });
        } else if ((m = dataRe.exec(line))) {
            out.push({ kind: 'data', type: m[1], name: m[2], lineIndex: i });
        }
    }
    return out;
}

/**
 * Walk a block body for resource-address references. Matches both:
 *   - bare references inside HCL expressions:   `aws_iam_role.lambda_exec.arn`
 *   - interpolated references:                  `"${aws_lambda_function.handler.id}"`
 *   - module output references:                 `module.vpc.public_subnet_ids`
 *   - data source references:                   `data.aws_caller_identity.current.account_id`
 *
 * Resolves each reference to its record id when known. Unknown
 * references (e.g. cross-file references to addresses not parsed yet)
 * are dropped — they would create dangling edges in the L1 graph.
 */
function findReferences(body: string, addressToId: Map<string, string>): Set<string> {
    const refs = new Set<string>();
    // module.<name>[.<output>] — capture just the address head.
    const moduleRe = /\bmodule\.([A-Za-z_][A-Za-z0-9_-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = moduleRe.exec(body)) !== null) {
        const id = addressToId.get(`module.${m[1]}`);
        if (id) refs.add(id);
    }
    // data.<type>.<name>[.<attr>] — kept as opaque dependency strings
    // for downstream visualisation; the address isn't a record id since
    // we skipped data sources above.
    const dataRe = /\bdata\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g;
    while ((m = dataRe.exec(body)) !== null) {
        const addr = `data.${m[1]}.${m[2]}`;
        if (addressToId.has(addr)) refs.add(addr); // string, not an id
    }
    // <provider>_<resource>.<name>[.<attr>] — provider prefix is what
    // makes a resource-type token unambiguous; require ≥ 2 underscored
    // segments before the first dot to filter false positives like
    // `some_local_variable.something`.
    const resourceRe = /\b([a-z][a-z0-9]*_[a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_-]*)/g;
    while ((m = resourceRe.exec(body)) !== null) {
        const id = addressToId.get(`${m[1]}.${m[2]}`);
        if (id) refs.add(id);
    }
    return refs;
}

/**
 * Pluck the provider name out of a Terraform resource type. By
 * convention the prefix before the first underscore is the provider:
 * `aws_lambda_function` → `aws`, `google_storage_bucket` → `google`,
 * `kubernetes_deployment` → `kubernetes`.
 */
function providerFor(type: string): string {
    const idx = type.indexOf('_');
    return idx > 0 ? type.slice(0, idx) : type;
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1;
    return n;
}
