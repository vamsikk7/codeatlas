/**
 * infra/graphql.ts — Issue #705 Phase 2 GraphQL SDL parser.
 *
 * Extracts top-level `type <Name> { … }` declarations from `.graphql` /
 * `.gql` schema files and emits one record per type. Special-cases the
 * root operation types (`Query` / `Mutation` / `Subscription`): each
 * field on those types becomes a separate `graphql-query` record so the
 * L2b api-list panel can render them as endpoints alongside HTTP routes.
 *
 * Regex-based scan with brace tracking. The SDL grammar is rigid enough
 * that we don't need a real parser:
 *
 *   type Article { id: ID! title: String! }
 *   input CreateArticleInput { title: String! }
 *   enum ArticleState { DRAFT PUBLISHED ARCHIVED }
 *   type Query { article(id: ID!): Article }
 *   type Mutation { createArticle(input: CreateArticleInput!): Article }
 *   type Subscription { articleCreated: Article }
 *
 * Comments (`# …`) and triple-quoted descriptions are stripped before
 * parsing. Schema directives + `extend type` declarations land as
 * additional records keyed by the same name.
 *
 * Detected only on files inside any `frameworkDetector.ts` GraphQL
 * usage is OUT OF SCOPE here — that path picks up Apollo/NestJS resolver
 * methods in source code. This parser handles bare SDL files only.
 */

import type { InfraRecord, Anchor } from '../../graph/graphTypes';

export function canParseGraphql(filePath: string): boolean {
    return /\.(graphql|gql|graphqls)$/i.test(filePath);
}

interface TypeBlock {
    keyword: 'type' | 'input' | 'enum' | 'interface' | 'union';
    name: string;
    headerLine: number;
    body: string;
    isExtension: boolean;
}

const ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);

export function parseGraphql(filePath: string, source: string): InfraRecord[] {
    const stripped = stripCommentsAndDescriptions(source);
    const lines = source.split('\n');
    const blocks = findTypeBlocks(stripped);
    if (blocks.length === 0) return [];

    const records: InfraRecord[] = [];

    for (const block of blocks) {
        if (block.keyword === 'type' && ROOT_TYPES.has(block.name)) {
            // Each field of Query/Mutation/Subscription becomes its own record.
            const fields = findRootFields(block.body);
            const operationLabel = block.name.toUpperCase(); // QUERY / MUTATION / SUBSCRIPTION
            for (const field of fields) {
                records.push({
                    id: `infra:graphql-query:${filePath}::${block.name}.${field.name}`,
                    kind: 'graphql-query',
                    name: `${operationLabel} ${field.name}`,
                    filePath,
                    anchor: spanAnchor(filePath, field.name, lines, block.headerLine),
                    meta: {
                        operation: block.name.toLowerCase(),
                        field: field.name,
                        returnType: field.returnType,
                        args: field.args,
                    },
                });
            }
        } else {
            records.push({
                id: `infra:graphql-type:${filePath}::${block.name}${block.isExtension ? '+ext' : ''}`,
                kind: 'graphql-type',
                name: block.name,
                filePath,
                anchor: spanAnchor(filePath, block.name, lines, block.headerLine),
                meta: {
                    keyword: block.keyword,
                    extension: block.isExtension || undefined,
                },
            });
        }
    }

    return records;
}

function findTypeBlocks(stripped: string): TypeBlock[] {
    const out: TypeBlock[] = [];
    // Matches `[extend] (type|input|enum|interface|union) Name [implements X] {` so
    // we can also pick up `extend type Query` extensions. The opening
    // brace is required so we know we have a body to scan.
    const re = /(?:^|\n)\s*(extend\s+)?(type|input|enum|interface|union)\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingBrace(stripped, openIdx);
        if (closeIdx < 0) continue;
        const body = stripped.slice(openIdx + 1, closeIdx);
        const headerLine = offsetToLine(stripped, m.index);
        out.push({
            keyword: m[2] as TypeBlock['keyword'],
            name: m[3],
            headerLine,
            body,
            isExtension: Boolean(m[1]),
        });
    }
    return out;
}

interface RootField {
    name: string;
    returnType: string;
    args: Array<{ name: string; type: string }>;
}

function findRootFields(body: string): RootField[] {
    const fields: RootField[] = [];
    // SDL field: `name(arg1: Type, arg2: Type!): ReturnType`. The arg list
    // is optional. The non-null `!` and array `[…]` markers stay in the
    // captured type string.
    const fieldRe = /(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:\s*([^\n}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(body)) !== null) {
        const args = m[2] ? splitArgs(m[2]).map(parseArg).filter((a): a is { name: string; type: string } => !!a) : [];
        fields.push({ name: m[1], returnType: m[3].trim(), args });
    }
    return fields;
}

function splitArgs(argList: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argList.length; i++) {
        const ch = argList[i];
        if (ch === '[' || ch === '{' || ch === '(') depth++;
        else if (ch === ']' || ch === '}' || ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(argList.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(argList.slice(start));
    return parts.map(s => s.trim()).filter(Boolean);
}

function parseArg(raw: string): { name: string; type: string } | undefined {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)(?:\s*=\s*.+)?$/.exec(raw);
    if (!m) return undefined;
    return { name: m[1], type: m[2].trim() };
}

function stripCommentsAndDescriptions(source: string): string {
    // `# line comment` — replace with spaces to preserve indices.
    let out = source.replace(/#[^\n]*/g, m => ' '.repeat(m.length));
    // `"""block description"""` — replace with newlines + spaces.
    out = out.replace(/"""[\s\S]*?"""/g, m =>
        m.split('').map(ch => (ch === '\n' ? '\n' : ' ')).join(''),
    );
    // Inline description strings: `"…"` directly preceding a type/field
    // are allowed in SDL but we don't track them. Leave alone.
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

function spanAnchor(filePath: string, symbol: string, lines: string[], lineIndex: number): Anchor {
    return {
        filePath,
        symbol,
        span: {
            start: charOffsetOfLine(lines, lineIndex),
            end: charOffsetOfLine(lines, lineIndex + 1),
        },
    };
}

function charOffsetOfLine(lines: string[], lineIndex: number): number {
    let n = 0;
    const cap = Math.min(lineIndex, lines.length);
    for (let i = 0; i < cap; i++) n += lines[i].length + 1;
    return n;
}
