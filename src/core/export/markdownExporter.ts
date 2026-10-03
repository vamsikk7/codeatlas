/**
 * markdownExporter.ts
 *
 * Exports a Snapshot as a Markdown document with embedded Mermaid diagrams.
 * Covers all 5 layers of the CodeAtlas architecture:
 *   L1: System Design (services + infra)
 *   L2a: Feature Clusters
 *   L2b: API Catalog (table)
 *   Health Summary
 *   Diff Summary (when baseline != working)
 */

import * as path from 'path';
import { getLazyGraphMap } from '../storage/lazyGraphMap';
import { markdownAttributionFooter } from '../../lib/attribution';
import type {
    Snapshot,
    ServiceRecord,
    FeatureCluster,
    ApiRecord,
    DiagramGraph,
    GraphNode,
    GraphEdge,
    HealthReport,
    DiffStatus,
} from '../graph/graphTypes';

// ─── Mermaid helpers ─────────────────────────────────────────────────────────

/** Issue 234: Escape characters that break Mermaid labels (including apostrophes, backticks) */
function esc(label: string): string {
    return label.replace(/"/g, '#quot;').replace(/'/g, '#apos;').replace(/`/g, '&#96;').replace(/[<>{}|]/g, '_');
}

/** Issue 233: Mermaid-safe node ID — append hash suffix to prevent collisions (node-1 vs node_1) */
function mermaidId(raw: string): string {
    const base = raw.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    // Add short hash to distinguish IDs that normalize to the same string
    let h = 0;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    return `${base}_${(h >>> 0).toString(36).slice(0, 4)}`;
}

/** Diff emoji prefix for markdown text */
function diffIcon(diff?: DiffStatus): string {
    if (!diff || diff === 'unchanged') return '';
    if (diff === 'added') return '\u{1F7E2} ';
    if (diff === 'deleted') return '\u{1F534} ';
    if (diff === 'modified') return '\u{1F7E0} ';
    return '';
}

/** Mermaid style class definitions for diff coloring */
const MERMAID_DIFF_STYLES = [
    'classDef added fill:#c8e6c9,stroke:#388e3c,color:#1b5e20',
    'classDef deleted fill:#ffcdd2,stroke:#d32f2f,color:#b71c1c',
    'classDef modified fill:#fff3e0,stroke:#f57c00,color:#e65100',
    'classDef unchanged fill:#e3f2fd,stroke:#1976d2,color:#0d47a1',
].join('\n    ');

/** Mermaid infra shape: cylinder for database, hexagon for cache/queue, rounded for external */
function infraShape(kind: string, id: string, label: string): string {
    const mid = mermaidId(id);
    const safe = esc(label);
    switch (kind) {
        case 'database': return `${mid}[("${safe}")]`;
        case 'cache':    return `${mid}{{"${safe}"}}`;
        case 'queue':    return `${mid}{{"${safe}"}}`;
        default:         return `${mid}("${safe}")`;
    }
}

/** Kind icon for infra nodes */
function infraIcon(kind: string): string {
    switch (kind) {
        case 'database': return '\u{1F5C4}\u{FE0F}';
        case 'cache':    return '\u{26A1}';
        case 'queue':    return '\u{1F4E8}';
        default:         return '\u{1F50C}';
    }
}

// ─── Section builders ────────────────────────────────────────────────────────

/**
 * Build the L1 System Design Mermaid diagram from the microservice graph.
 */
function buildSystemDesignSection(
    snapshot: Snapshot,
    repoName: string,
): string {
    const services = snapshot.services ?? {};
    const serviceList = Object.values(services);
    const graph = snapshot.graphs['microservice:workspace'];

    if (serviceList.length === 0 && !graph) {
        return '> No services detected.\n';
    }

    const lines: string[] = [];
    lines.push(`**${repoName}** \u00B7 ${serviceList.length} service${serviceList.length !== 1 ? 's' : ''}`);
    lines.push('');

    // Build Mermaid from the stored microservice graph if available
    if (graph) {
        lines.push('```mermaid');
        lines.push('graph TB');
        lines.push(`    ${MERMAID_DIFF_STYLES}`);

        const nodeIdMap = new Map<string, string>(); // node.id → mermaidId

        for (const node of graph.nodes) {
            const mid = mermaidId(node.id);
            nodeIdMap.set(node.id, mid);
            const isInfra = node.meta?.infra === true;
            const kind = (node.meta?.kind as string) ?? '';

            if (isInfra) {
                lines.push(`    ${infraShape(kind, node.id, node.label)}`);
            } else {
                const tech = node.subtitle ? `<br/>${esc(node.subtitle)}` : '';
                lines.push(`    ${mid}["${esc(node.label)}${tech}"]`);
            }

            if (node.diff && node.diff !== 'unchanged') {
                lines.push(`    class ${mid} ${node.diff}`);
            }
        }

        for (const edge of graph.edges) {
            const src = nodeIdMap.get(edge.source);
            const tgt = nodeIdMap.get(edge.target);
            if (!src || !tgt) continue;
            const label = edge.label ? `|"${esc(edge.label)}"|` : '';
            lines.push(`    ${src} -->${label} ${tgt}`);
        }

        lines.push('```');
    }

    // Service detail table
    if (serviceList.length > 0) {
        lines.push('');
        lines.push('| Service | Technology | APIs | Root Path | Status |');
        lines.push('|---------|-----------|------|-----------|--------|');
        for (const svc of serviceList) {
            const icon = diffIcon(svc.diff);
            lines.push(`| ${icon}${svc.name} | ${svc.technology} | ${svc.exposedApiCount} | \`${svc.rootPath || '/'}\` | ${svc.diff ?? 'unchanged'} |`);
        }
    }

    return lines.join('\n');
}

/**
 * Build the L2a Feature Clusters section with Mermaid diagram.
 */
function buildFeatureClustersSection(snapshot: Snapshot): string {
    const clusters = snapshot.clusters ?? {};
    const clusterList = Object.values(clusters);

    if (clusterList.length === 0) {
        return '> No feature clusters detected.\n';
    }

    const lines: string[] = [];

    // Find the feature graph (prefer service-scoped, fall back to workspace)
    const featureGraphId = Object.keys(snapshot.graphs).find(id => id.startsWith('feature:'));
    const featureGraph = featureGraphId ? snapshot.graphs[featureGraphId] : undefined;

    if (featureGraph) {
        lines.push('```mermaid');
        lines.push('graph TB');
        lines.push(`    ${MERMAID_DIFF_STYLES}`);

        const nodeIdMap = new Map<string, string>();
        for (const node of featureGraph.nodes) {
            const mid = mermaidId(node.id);
            nodeIdMap.set(node.id, mid);
            const fileCount = (node.meta?.files as string[])?.length ?? 0;
            const apiCount = (node.meta?.apisInCluster as unknown[])?.length ?? 0;
            lines.push(`    ${mid}["${esc(node.label)}<br/>${fileCount} files \u00B7 ${apiCount} APIs"]`);
            if (node.diff && node.diff !== 'unchanged') {
                lines.push(`    class ${mid} ${node.diff}`);
            }
        }

        for (const edge of featureGraph.edges) {
            const src = nodeIdMap.get(edge.source);
            const tgt = nodeIdMap.get(edge.target);
            if (!src || !tgt) continue;
            const label = edge.label ? `|"${esc(edge.label)}"|` : '';
            lines.push(`    ${src} -->${label} ${tgt}`);
        }

        lines.push('```');
    }

    // Cluster detail list
    lines.push('');
    for (const cluster of clusterList) {
        const icon = diffIcon(cluster.diff);
        const apiCount = cluster.apisInCluster?.length ?? cluster.entryPoints.length;
        lines.push(`### ${icon}${cluster.name || cluster.label}`);
        lines.push('');
        lines.push(`- **Files:** ${cluster.files.length}`);
        lines.push(`- **APIs:** ${apiCount}`);
        lines.push(`- **Cohesion:** ${cluster.internalCallCount + cluster.externalCallCount > 0
            ? Math.round((cluster.internalCallCount / (cluster.internalCallCount + cluster.externalCallCount)) * 100)
            : 0}%`);
        if (cluster.serviceId) {
            lines.push(`- **Service:** ${cluster.serviceId}`);
        }
        if (cluster.modularity !== undefined) {
            lines.push(`- **Modularity Q:** ${cluster.modularity.toFixed(3)}`);
        }

        // List member files
        if (cluster.files.length > 0) {
            lines.push('');
            lines.push('<details><summary>Member files</summary>');
            lines.push('');
            for (const f of cluster.files) {
                lines.push(`- \`${f}\``);
            }
            lines.push('');
            lines.push('</details>');
        }

        // List APIs in cluster
        if (cluster.apisInCluster && cluster.apisInCluster.length > 0) {
            lines.push('');
            lines.push('| Method | Route | Handler |');
            lines.push('|--------|-------|---------|');
            for (const api of cluster.apisInCluster) {
                const apiIcon = diffIcon(api.diff);
                lines.push(`| ${apiIcon}${api.method} | ${api.route} | ${api.handlerName} |`);
            }
        }

        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Build the L2b API Catalog section — table of all API endpoints.
 */
function buildApiCatalogSection(snapshot: Snapshot): string {
    const apis = Object.values(snapshot.apiIndex);

    if (apis.length === 0) {
        return '> No APIs detected.\n';
    }

    const lines: string[] = [];
    lines.push(`${apis.length} endpoint${apis.length !== 1 ? 's' : ''} detected.`);
    lines.push('');
    lines.push('| Method | Route | Handler | File | Status |');
    lines.push('|--------|-------|---------|------|--------|');

    // Sort by file path, then method
    const sorted = [...apis].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.method.localeCompare(b.method));

    for (const api of sorted) {
        const icon = diffIcon(api.diff);
        lines.push(`| ${icon}${api.method} | \`${api.route}\` | ${api.handlerName} | \`${api.filePath}\` | ${api.diff ?? '-'} |`);
    }

    return lines.join('\n');
}

/**
 * Build the Code Health Summary section.
 */
function buildHealthSection(health: HealthReport | undefined): string {
    if (!health) {
        return '> No health analysis available.\n';
    }

    const lines: string[] = [];

    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Dead functions (no callers) | ${health.deadFunctions.length} |`);
    lines.push(`| God files (>15 symbols) | ${health.godFiles.length} |`);
    lines.push(`| High coupling files (>10 edges) | ${health.highCouplingFiles.length} |`);
    lines.push(`| Cyclic dependencies | ${health.cyclicDependencies.length} |`);
    lines.push(`| Orphaned clusters | ${health.orphanedClusters.length} |`);

    if (health.godFiles.length > 0) {
        lines.push('');
        lines.push('**God files:**');
        for (const f of health.godFiles) {
            lines.push(`- \`${f}\``);
        }
    }

    if (health.cyclicDependencies.length > 0) {
        lines.push('');
        lines.push('**Cyclic dependencies:**');
        for (const cycle of health.cyclicDependencies) {
            lines.push(`- ${cycle.map(f => `\`${f}\``).join(' \u2192 ')}`);
        }
    }

    if (health.highCouplingFiles.length > 0) {
        lines.push('');
        lines.push('**High coupling files:**');
        for (const f of health.highCouplingFiles) {
            lines.push(`- \`${f}\``);
        }
    }

    return lines.join('\n');
}

/**
 * Build a diff summary section comparing baseline vs working.
 */
function buildDiffSummarySection(baseline: Snapshot, working: Snapshot): string {
    const lines: string[] = [];

    // Count API changes
    const baselineApis = new Set(Object.keys(baseline.apiIndex));
    const workingApis = new Set(Object.keys(working.apiIndex));
    const addedApis = [...workingApis].filter(a => !baselineApis.has(a)).length;
    const deletedApis = [...baselineApis].filter(a => !workingApis.has(a)).length;

    // Count file changes
    const baselineFiles = new Set(Object.keys(baseline.files));
    const workingFiles = new Set(Object.keys(working.files));
    const addedFiles = [...workingFiles].filter(f => !baselineFiles.has(f)).length;
    const deletedFiles = [...baselineFiles].filter(f => !workingFiles.has(f)).length;
    let modifiedFiles = 0;
    for (const fp of workingFiles) {
        if (baselineFiles.has(fp) && baseline.files[fp]?.hash !== working.files[fp]?.hash) {
            modifiedFiles++;
        }
    }

    // Count cluster changes
    const baselineClusters = Object.values(baseline.clusters ?? {});
    const workingClusters = Object.values(working.clusters ?? {});
    const clusterAdded = workingClusters.filter(c => c.diff === 'added').length;
    const clusterModified = workingClusters.filter(c => c.diff === 'modified').length;

    const hasChanges = addedFiles + deletedFiles + modifiedFiles + addedApis + deletedApis + clusterAdded + clusterModified > 0;

    if (!hasChanges) {
        return '> No changes detected between baseline and working snapshot.\n';
    }

    lines.push('| Layer | Added | Deleted | Modified |');
    lines.push('|-------|-------|---------|----------|');
    lines.push(`| Files | ${addedFiles} | ${deletedFiles} | ${modifiedFiles} |`);
    lines.push(`| APIs | ${addedApis} | ${deletedApis} | - |`);
    lines.push(`| Feature Clusters | ${clusterAdded} | - | ${clusterModified} |`);

    return lines.join('\n');
}

/**
 * Issue 115: Build the L3 Sequence Diagrams section with Mermaid sequenceDiagram blocks.
 */
function buildSequenceDiagramsSection(snapshot: Snapshot): string {
    // #355: pre-filter by ID before fetching bodies so we only realize the
    // graphs we'll actually render (sequence: subset, typically <100 of N).
    const lazyMap = getLazyGraphMap(snapshot.graphs);
    const seqIds = (lazyMap ? lazyMap.keys() : Object.keys(snapshot.graphs))
        .filter(id => id.startsWith('sequence:'));
    const seqGraphs: Array<[string, DiagramGraph]> = [];
    for (const id of seqIds) {
        const g = lazyMap ? lazyMap.get(id) : snapshot.graphs[id];
        if (g) seqGraphs.push([id, g]);
    }

    if (seqGraphs.length === 0) {
        return '> No sequence diagrams available.\n';
    }

    const lines: string[] = [];
    lines.push(`${seqGraphs.length} sequence diagram${seqGraphs.length !== 1 ? 's' : ''} generated.`);
    lines.push('');

    for (const [graphId, graph] of seqGraphs) {
        // Extract handler name from graphId: sequence:filePath:handlerName
        const firstColon = graphId.indexOf(':');
        const rest = graphId.slice(firstColon + 1);
        const label = graph.meta?.handler as string || rest;

        lines.push(`### ${esc(label)}`);
        lines.push('');
        lines.push('```mermaid');
        lines.push('sequenceDiagram');

        // Map participant nodes
        const participants = graph.nodes.filter(n => n.type === 'participant');
        for (const p of participants) {
            if (p.diff === 'deleted') continue; // skip ghost participants
            lines.push(`    participant ${mermaidId(p.id)} as ${esc(p.label)}`);
        }

        // Map message edges in order
        for (const edge of graph.edges) {
            if (edge.edgeType !== 'message') continue;
            // Skip edges involving only deleted participants
            const srcNode = participants.find(p => p.id === edge.source);
            const tgtNode = participants.find(p => p.id === edge.target);
            if (srcNode?.diff === 'deleted' && tgtNode?.diff === 'deleted') continue;

            const isReturn = edge.meta?.isReturn === true;
            const arrow = isReturn ? '-->>' : '->>';
            const edgeLabel = edge.label ? esc(edge.label) : '';
            lines.push(`    ${mermaidId(edge.source)}${arrow}${mermaidId(edge.target)}: ${edgeLabel}`);
        }

        lines.push('```');
        lines.push('');
    }

    return lines.join('\n');
}

// ─── Main export function ────────────────────────────────────────────────────

/**
 * Generate a complete Markdown architecture document from a snapshot.
 *
 * @param working    - The working snapshot (current state)
 * @param baseline   - The baseline snapshot (for diff summary); omit to skip diff section
 * @param repoName   - Human-readable repository name (e.g., path.basename(workspaceRoot))
 */
export function exportArchitectureDocs(
    working: Snapshot,
    baseline?: Snapshot,
    repoName: string = 'Workspace',
): string {
    const sections: string[] = [];

    // Header
    sections.push(`# ${repoName} \u2014 Architecture Documentation`);
    sections.push('');
    sections.push(`> Generated by [CodeAtlas](https://marketplace.visualstudio.com/items?itemName=codeatlas) on ${new Date().toISOString().split('T')[0]}`);
    sections.push('');

    // Table of contents
    sections.push('## Table of Contents');
    sections.push('');
    sections.push('1. [System Overview](#system-overview)');
    sections.push('2. [Feature Clusters](#feature-clusters)');
    sections.push('3. [API Catalog](#api-catalog)');
    sections.push('4. [Sequence Diagrams](#sequence-diagrams)');
    sections.push('5. [Code Health](#code-health)');
    if (baseline) {
        sections.push('6. [Diff Summary](#diff-summary)');
    }
    sections.push('');

    // L1: System Overview
    sections.push('---');
    sections.push('');
    sections.push('## System Overview');
    sections.push('');
    sections.push(buildSystemDesignSection(working, repoName));
    sections.push('');

    // L2a: Feature Clusters
    sections.push('---');
    sections.push('');
    sections.push('## Feature Clusters');
    sections.push('');
    sections.push(buildFeatureClustersSection(working));
    sections.push('');

    // L2b: API Catalog
    sections.push('---');
    sections.push('');
    sections.push('## API Catalog');
    sections.push('');
    sections.push(buildApiCatalogSection(working));
    sections.push('');

    // L3: Sequence Diagrams (Issue 115 — Markdown export missing L3 sequence diagrams)
    sections.push('---');
    sections.push('');
    sections.push('## Sequence Diagrams');
    sections.push('');
    sections.push(buildSequenceDiagramsSection(working));
    sections.push('');

    // Health
    sections.push('---');
    sections.push('');
    sections.push('## Code Health');
    sections.push('');
    sections.push(buildHealthSection(working.health));
    sections.push('');

    // Diff summary (only when baseline provided)
    if (baseline) {
        sections.push('---');
        sections.push('');
        sections.push('## Diff Summary');
        sections.push('');
        sections.push(buildDiffSummarySection(baseline, working));
        sections.push('');
    }

    sections.push(markdownAttributionFooter());

    return sections.join('\n');
}
