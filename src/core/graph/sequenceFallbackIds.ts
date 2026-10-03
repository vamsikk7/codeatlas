/**
 * sequenceFallbackIds.ts — #843 (2026-06-11).
 *
 * A sequence graphId is `sequence:<filePath>:<handlerName>` — but handler
 * names can themselves contain ':' (`anonymous@GET:/user`), so the split
 * point is ambiguous. Derive every plausible (filePath, handler) split and
 * emit the fallback graph ids to try when the sequence graph is missing:
 * all `flow:` candidates first (closest substitute), then `file:` ones.
 * The CALLER uses graph existence as the oracle — first candidate that
 * resolves to a non-empty graph wins; see ADR-039 (the same chain
 * openSequenceForApi ships, applied to the requestRoute path tours use).
 */

export interface SequenceFallbackCandidate {
    gid: string;
    mode: 'flow' | 'file';
    label: string;
}

export function deriveSequenceFallbackIds(seqParam: string): SequenceFallbackCandidate[] {
    const flows: SequenceFallbackCandidate[] = [];
    const files: SequenceFallbackCandidate[] = [];
    const seen = new Set<string>();
    for (let i = seqParam.indexOf(':'); i !== -1; i = seqParam.indexOf(':', i + 1)) {
        const fp = seqParam.slice(0, i);
        const handler = seqParam.slice(i + 1);
        // A plausible file path has an extension dot in its last segment.
        const last = fp.split('/').pop() ?? '';
        if (!last.includes('.')) continue;
        if (handler) {
            flows.push({ gid: `flow:${fp}:${handler}`, mode: 'flow', label: `Flow: ${handler}` });
        }
        if (!seen.has(fp)) {
            seen.add(fp);
            files.push({ gid: `file:${fp}`, mode: 'file', label: `File: ${last}` });
        }
    }
    return [...flows, ...files];
}
