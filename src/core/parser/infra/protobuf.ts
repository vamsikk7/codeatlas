/**
 * infra/protobuf.ts — Issue #705 Phase 2 Protocol Buffers (.proto) parser.
 *
 * Extracts `service Foo { … }` declarations and each `rpc <Method>(<Req>)
 * returns (<Resp>);` inside them. Each service emits a `protobuf-service`
 * record + each rpc emits a `protobuf-rpc` record (with the service id
 * in `dependencies` so the L1 graph wires them up).
 *
 * Regex-based scan with light brace tracking. The grammar for service +
 * rpc declarations is rigid enough that we don't need protoc:
 *
 *   service ChatService {
 *     rpc SendMessage(SendRequest) returns (SendResponse);
 *     rpc StreamMessages(StreamRequest) returns (stream MessageEvent);
 *   }
 *
 * We honour the `stream` keyword on either side (client-stream / server-
 * stream / bi-directional) and stash it in `meta`. Comments (`//` + `/*`)
 * are stripped before scanning.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

export function canParseProto(filePath: string): boolean {
    return /\.proto$/i.test(filePath);
}

interface RpcMethod {
    name: string;
    request: string;
    response: string;
    streamRequest: boolean;
    streamResponse: boolean;
    lineIndex: number;
}

interface ServiceBlock {
    name: string;
    lineIndex: number;
    body: string;
    rpcs: RpcMethod[];
}

export function parseProto(filePath: string, source: string): InfraRecord[] {
    const stripped = stripComments(source);
    const lines = source.split('\n');
    const services = findServices(stripped, lines);
    if (services.length === 0) return [];

    const records: InfraRecord[] = [];
    for (const svc of services) {
        const svcId = `infra:protobuf-service:${filePath}::${svc.name}`;
        records.push({
            id: svcId,
            kind: 'protobuf-service',
            name: svc.name,
            filePath,
            anchor: {
                filePath,
                symbol: svc.name,
                span: {
                    start: charOffsetOfLine(lines, svc.lineIndex),
                    end: charOffsetOfLine(lines, svc.lineIndex + 1),
                },
            },
            meta: { rpcCount: svc.rpcs.length },
        });
        for (const rpc of svc.rpcs) {
            records.push({
                id: `infra:protobuf-rpc:${filePath}::${svc.name}.${rpc.name}`,
                kind: 'protobuf-rpc',
                name: `${svc.name}.${rpc.name}`,
                filePath,
                anchor: {
                    filePath,
                    symbol: rpc.name,
                    span: {
                        start: charOffsetOfLine(lines, rpc.lineIndex),
                        end: charOffsetOfLine(lines, rpc.lineIndex + 1),
                    },
                },
                dependencies: [svcId],
                meta: {
                    service: svc.name,
                    request: rpc.request,
                    response: rpc.response,
                    streamRequest: rpc.streamRequest,
                    streamResponse: rpc.streamResponse,
                },
            });
        }
    }

    return records;
}

function findServices(stripped: string, lines: string[]): ServiceBlock[] {
    const out: ServiceBlock[] = [];
    const svcRe = /service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = svcRe.exec(stripped)) !== null) {
        const openIdx = m.index + m[0].length - 1; // position of `{`
        const closeIdx = findMatchingBrace(stripped, openIdx);
        if (closeIdx < 0) continue;
        const body = stripped.slice(openIdx + 1, closeIdx);
        const headerLine = offsetToLine(stripped, m.index);
        const rpcs = findRpcs(body, headerLine, stripped, openIdx + 1);
        out.push({ name: m[1], lineIndex: headerLine, body, rpcs });
    }
    return out;
}

function findRpcs(body: string, headerLine: number, fullText: string, bodyOffset: number): RpcMethod[] {
    const rpcs: RpcMethod[] = [];
    // rpc Method ( [stream] RequestType ) returns ( [stream] ResponseType ) ;
    const rpcRe = /rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*[;{]/g;
    let m: RegExpExecArray | null;
    while ((m = rpcRe.exec(body)) !== null) {
        rpcs.push({
            name: m[1],
            request: m[3],
            response: m[5],
            streamRequest: Boolean(m[2]),
            streamResponse: Boolean(m[4]),
            lineIndex: offsetToLine(fullText, bodyOffset + m.index),
        });
    }
    return rpcs;
}

/**
 * Strip both `//`-line comments and `/* … *​/` block comments while
 * preserving line counts (so the offset-to-line conversion below stays
 * accurate). Block comments are replaced by an equivalent number of
 * blank chars per line.
 */
function stripComments(source: string): string {
    let out = source;
    // Line comments → replace with spaces of equal length.
    out = out.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
    // Block comments → walk + preserve newlines.
    out = out.replace(/\/\*[\s\S]*?\*\//g, m => m.split('').map(ch => (ch === '\n' ? '\n' : ' ')).join(''));
    return out;
}

function findMatchingBrace(text: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function offsetToLine(text: string, offset: number): number {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1;
    return n;
}
