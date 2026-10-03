/**
 * infra/k8s.ts — Issue #705 Phase 2 Kubernetes manifest parser.
 *
 * Extracts `kind: <Deployment|Service|Ingress|CronJob>` documents from
 * `.yaml` / `.yml` files and emits one `InfraRecord` per document. A
 * single file may contain multiple manifests separated by `---`; each
 * one becomes its own record.
 *
 * Regex-based (no YAML parser dependency). K8s YAML structure is
 * predictable enough that we can lift the four fields we need —
 * `kind`, `metadata.name`, `metadata.namespace`, and the dependency-
 * shaped attributes (`spec.selector.matchLabels` for Deployments → the
 * Service it backs; `spec.rules.host` for Ingresses) — without
 * deserializing the whole document. Comments + flow-style YAML
 * (`{ foo: bar }`) are tolerated; multi-line strings are skipped on
 * the dependency-extraction pass.
 *
 * `canParse` deliberately matches *any* `.yaml`/`.yml` path so that
 * mixed repos (Helm charts, raw manifests, CI workflows) all flow
 * through this parser; non-K8s YAML files emit zero records via the
 * empty `kind:` early-exit and remain harmless.
 */

import type { InfraRecord, Anchor, InfraKind } from '../../graph/graphTypes';

export function canParseK8s(filePath: string): boolean {
    return /\.ya?ml$/i.test(filePath);
}

const KIND_MAP: Record<string, InfraKind> = {
    Deployment: 'k8s-deployment',
    Service: 'k8s-service',
    Ingress: 'k8s-ingress',
    CronJob: 'k8s-cronjob',
};

interface Doc {
    startLine: number;
    endLine: number; // exclusive
    body: string[];
}

export function parseK8s(filePath: string, source: string): InfraRecord[] {
    const lines = source.split('\n');
    const docs = splitDocuments(lines);
    const records: InfraRecord[] = [];

    for (const doc of docs) {
        const kindRaw = pluckTopLevel(doc.body, 'kind');
        if (!kindRaw) continue;
        const k8sKind = KIND_MAP[kindRaw];
        if (!k8sKind) continue;

        const name = pluckMetadataField(doc.body, 'name');
        if (!name) continue;
        const namespace = pluckMetadataField(doc.body, 'namespace');
        const deps = extractDeps(kindRaw, doc.body);

        const id = `infra:${k8sKind}:${filePath}::${namespace ? `${namespace}/` : ''}${name}`;
        const anchor: Anchor = {
            filePath,
            symbol: name,
            span: {
                start: charOffsetOfLine(lines, doc.startLine),
                end: charOffsetOfLine(lines, Math.min(doc.endLine, lines.length)),
            },
        };

        const meta: Record<string, unknown> = { kubernetesKind: kindRaw };
        if (namespace) meta.namespace = namespace;
        const labels = extractMatchLabels(doc.body);
        if (labels) meta.selectorLabels = labels;

        records.push({
            id,
            kind: k8sKind,
            name,
            filePath,
            anchor,
            dependencies: deps.length > 0 ? deps : undefined,
            meta,
        });
    }

    return records;
}

function splitDocuments(lines: string[]): Doc[] {
    const docs: Doc[] = [];
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^---\s*$/.test(lines[i])) {
            if (i > start) docs.push({ startLine: start, endLine: i, body: lines.slice(start, i) });
            start = i + 1;
        }
    }
    if (start < lines.length) {
        docs.push({ startLine: start, endLine: lines.length, body: lines.slice(start) });
    }
    return docs;
}

function pluckTopLevel(body: string[], key: string): string | undefined {
    // Top-level keys live at column 0 (no leading whitespace). Match
    // both inline (`key: value`) and quoted (`key: "value"`) forms.
    const re = new RegExp(`^${key}\\s*:\\s*"?([^"\\n]+?)"?\\s*$`);
    for (const line of body) {
        const m = re.exec(line);
        if (m) return m[1].trim();
    }
    return undefined;
}

function pluckMetadataField(body: string[], field: string): string | undefined {
    // metadata: { name, namespace, labels } — block-style only. Walk
    // until we hit the `metadata:` key, then read 1+ indented children.
    let inMetadata = false;
    let baseIndent = -1;
    for (const line of body) {
        if (!inMetadata) {
            if (/^metadata\s*:\s*$/.test(line)) {
                inMetadata = true;
                baseIndent = -1;
                continue;
            }
            // Inline form: `metadata: { name: foo, namespace: bar }` — pluck via flow regex.
            const inline = new RegExp(`^metadata\\s*:\\s*\\{[^}]*\\b${field}\\s*:\\s*"?([^",}]+)"?`).exec(line);
            if (inline) return inline[1].trim();
            continue;
        }
        // Inside metadata block: stop at the next top-level key.
        if (/^\S/.test(line) && !/^\s/.test(line)) break;
        const m = new RegExp(`^(\\s+)${field}\\s*:\\s*"?([^"\\n]+?)"?\\s*$`).exec(line);
        if (m) {
            const indent = m[1].length;
            if (baseIndent < 0) baseIndent = indent;
            if (indent === baseIndent) return m[2].trim();
        }
    }
    return undefined;
}

function extractMatchLabels(body: string[]): Record<string, string> | undefined {
    // spec.selector.matchLabels: { app: foo, tier: backend } — used by
    // Deployments + Services. Block form only.
    const out: Record<string, string> = {};
    let depth = 0;
    let captureIndent = -1;
    let inMatchLabels = false;
    for (const line of body) {
        if (!inMatchLabels) {
            if (/^\s*matchLabels\s*:\s*$/.test(line) || /^\s*selector\s*:\s*$/.test(line)) {
                // For `selector:` we keep depth so the next `matchLabels:` triggers.
                if (/matchLabels/.test(line)) {
                    inMatchLabels = true;
                    captureIndent = (line.match(/^(\s*)/)?.[1].length ?? 0) + 2;
                }
                depth++;
                continue;
            }
            continue;
        }
        const lead = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (lead < captureIndent) break;
        const m = /^\s+([A-Za-z_][\w./-]*)\s*:\s*"?([^"\n]+?)"?\s*$/.exec(line);
        if (m) out[m[1]] = m[2].trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function extractDeps(kind: string, body: string[]): string[] {
    // For Services + Ingresses + Deployments we surface the inter-
    // manifest connection so the L1 layout reflects intent. Bare
    // address strings — the dispatcher caller can resolve them across
    // the workspace if it wants tighter edges. Today we emit lite
    // refs of the shape `k8s:<ref>:<value>` which downstream code
    // (service detector + L1 builder) can recognise.
    const deps: string[] = [];
    if (kind === 'Ingress') {
        // backend: { service: { name: foo, port: 80 } }
        for (const line of body) {
            const m = /^\s*service\s*:\s*\{?[^}]*\bname\s*:\s*"?([^",}\s]+)/.exec(line) || /^\s+name\s*:\s*"?([^"\n]+?)"?\s*$/.exec(line);
            if (m && /service/i.test(line) || /backend/i.test(line)) {
                if (m) deps.push(`k8s:service-ref:${m[1].trim()}`);
            }
        }
    }
    if (kind === 'Deployment' || kind === 'CronJob') {
        // Container images — surfaced as image refs so the docker-
        // stage parser can correlate later. Allow the YAML list-item
        // dash (`- image: …`) plus any indent depth.
        for (const line of body) {
            const m = /^\s*-?\s*image\s*:\s*"?([^"\s]+)"?\s*$/.exec(line);
            if (m) deps.push(`k8s:image-ref:${m[1].trim()}`);
        }
    }
    return [...new Set(deps)];
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1;
    return n;
}
