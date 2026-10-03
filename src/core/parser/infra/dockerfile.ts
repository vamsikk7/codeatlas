/**
 * infra/dockerfile.ts — Issue #705 Phase 1 Dockerfile parser.
 *
 * Extracts `FROM <image> [AS <stage>]` lines as `docker-stage` records.
 * Each multi-stage build target becomes one record; the meta carries
 * the base image + any inter-stage `COPY --from=` dependencies so the
 * downstream service detector can mark the final stage as the "runtime
 * intent" service and the earlier stages as build artifacts.
 *
 * Deliberately regex-based (not a real Dockerfile grammar) — Docker's
 * syntax is loose, line-continuation-heavy, and we only need to lift
 * the structural anchors (FROM lines, AS labels, --from references)
 * for the L1 architecture view. Comments + ARG substitution are out of
 * scope for the MVP.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

export function canParseDockerfile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('/dockerfile')) return true;
    if (lower === 'dockerfile') return true;
    // Variants like `Dockerfile.dev`, `Dockerfile.prod`, `web.Dockerfile`.
    if (/(^|\/)dockerfile(\.[a-z0-9_-]+)?$/i.test(filePath)) return true;
    if (/\.dockerfile$/i.test(filePath)) return true;
    return false;
}

/**
 * Extract stage records from one Dockerfile.
 *
 * Each `FROM <image> [AS <stage>]` line emits one record:
 *   - id: `infra:docker-stage:<filePath>::<stageName>`
 *   - name: `<stageName>` (or `<image>` when no AS clause was supplied)
 *   - meta.image: the base image reference (e.g. `node:20-alpine`)
 *   - meta.platform: the optional `--platform=` qualifier
 *   - meta.stageIndex: zero-based position in the file (helps determine
 *                      which stage is "final" — the last one)
 *   - dependencies: any `COPY --from=<other>` references found in the
 *                   stage's body block
 */
export function parseDockerfile(filePath: string, source: string): InfraRecord[] {
    const lines = source.split('\n');
    const records: InfraRecord[] = [];
    type StagePos = { name: string; image: string; platform?: string; lineIndex: number; index: number };
    const stages: StagePos[] = [];

    // Pass 1: discover stages.
    const fromRe = /^\s*FROM\s+(?:--platform=(\S+)\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;
    let stageIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = fromRe.exec(lines[i]);
        if (!m) continue;
        const platform = m[1];
        const image = m[2];
        const explicitName = m[3];
        const name = explicitName ?? image.split('/').pop()?.split(':')[0] ?? `stage${stageIndex}`;
        stages.push({ name, image, platform, lineIndex: i, index: stageIndex });
        stageIndex++;
    }

    if (stages.length === 0) return records;

    // Pass 2: per-stage scan for `COPY --from=<name>` and inferred deps.
    // The "stage body" runs from this FROM line to the next one (or EOF).
    for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];
        const bodyStart = stage.lineIndex + 1;
        const bodyEnd = s + 1 < stages.length ? stages[s + 1].lineIndex : lines.length;
        const depNames = new Set<string>();
        for (let i = bodyStart; i < bodyEnd; i++) {
            const line = lines[i];
            // `COPY --from=<name|index> ...` — Docker accepts either the
            // stage name OR its 0-based numeric index. Resolve indices
            // back to names so the dependency edge is stable across
            // edits that reorder stages.
            const cm = /^\s*COPY\s+--from=([^\s]+)/i.exec(line);
            if (cm) {
                const ref = cm[1];
                if (/^\d+$/.test(ref)) {
                    const idx = Number(ref);
                    if (idx >= 0 && idx < stages.length) depNames.add(stages[idx].name);
                } else {
                    depNames.add(ref);
                }
            }
        }

        const anchor: Anchor = {
            filePath,
            symbol: stage.name,
            span: { start: charOffsetOfLine(lines, stage.lineIndex), end: charOffsetOfLine(lines, stage.lineIndex + 1) },
        };
        records.push({
            id: `infra:docker-stage:${filePath}::${stage.name}`,
            kind: 'docker-stage',
            name: stage.name,
            filePath,
            anchor,
            dependencies: depNames.size > 0
                ? [...depNames].map(n => `infra:docker-stage:${filePath}::${n}`)
                : undefined,
            meta: {
                image: stage.image,
                platform: stage.platform,
                stageIndex: stage.index,
                isFinalStage: s === stages.length - 1,
            },
        });
    }

    return records;
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1; // +1 for the consumed '\n'
    return n;
}
