/**
 * schemaInference/classValidator.ts — Issue #600 Phase 0
 * class-validator inference.
 *
 * Different shape from Zod / Joi: class-validator uses TypeScript
 * decorators on class fields, NOT a function-call chain. We scan a
 * class-DTO declaration and lift the decorated fields into a
 * `JsonSchemaLike`.
 *
 * Recognised decorator set (covers ~90% of NestJS DTOs):
 *
 *   @IsString() / @IsNumber() / @IsBoolean() / @IsDate()
 *   @IsInt() / @IsArray() / @IsObject()
 *   @IsOptional()                — drops the field from `required[]`
 *   @IsNotEmpty()                — implicit required (mirrors default)
 *   @IsEmail() / @IsUrl() / @IsUUID() — format hint
 *   @IsEnum(EnumOrLiteralArr)    — enum constraint (best-effort)
 *   @MinLength(n) / @MaxLength(n) / @Min(n) / @Max(n)  — ignored (v0)
 *
 * Field type is also lifted from the TS annotation (`name: string` →
 * `string`, `tags: string[]` → `array<string>`, `meta?: ProfileDto`
 * → optional reference (surfaced as a description hint)).
 */

import type { InferredApiSchema } from './types';
import type { JsonSchemaLike } from '../../graph/graphTypes';

export function parseClassValidatorDto(source: string, className: string): JsonSchemaLike | undefined {
    const block = extractClassBody(source, className);
    if (!block) return undefined;
    return classBodyToSchema(block);
}

export function parseClassValidatorInferredApiSchema(source: string, className: string): InferredApiSchema {
    const schema = parseClassValidatorDto(source, className);
    if (!schema) return {};
    return { requestSchema: { kind: 'json', schema, source: 'class-validator' } };
}

interface FieldDecl {
    name: string;
    decorators: Array<{ name: string; arg?: string }>;
    typeAnnotation?: string;
    optional: boolean;
}

function classBodyToSchema(body: string): JsonSchemaLike {
    const fields = parseFieldDeclarations(body);
    const properties: Record<string, JsonSchemaLike> = {};
    const required: string[] = [];
    for (const f of fields) {
        const propSchema = fieldToSchema(f);
        properties[f.name] = propSchema;
        const isOptional = f.optional || f.decorators.some(d => d.name === 'IsOptional');
        if (!isOptional) required.push(f.name);
        if (isOptional) propSchema.nullable = true;
    }
    const out: JsonSchemaLike = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
}

function fieldToSchema(f: FieldDecl): JsonSchemaLike {
    const out: JsonSchemaLike = {};

    // Type lifting from the TS annotation comes first; decorators refine.
    if (f.typeAnnotation) {
        const t = f.typeAnnotation.trim();
        if (t === 'string') out.type = 'string';
        else if (t === 'number') out.type = 'number';
        else if (t === 'boolean') out.type = 'boolean';
        else if (t === 'Date') { out.type = 'string'; out.format = 'date-time'; }
        else if (t.endsWith('[]')) {
            out.type = 'array';
            const inner = t.slice(0, -2).trim();
            if (inner === 'string') out.items = { type: 'string' };
            else if (inner === 'number') out.items = { type: 'number' };
            else if (inner === 'boolean') out.items = { type: 'boolean' };
            else out.items = { type: 'string', description: inner };
        } else {
            // Reference to a nested DTO — surface as a hint for the UI.
            out.type = 'object';
            out.description = `class ${t}`;
        }
    }

    for (const d of f.decorators) {
        switch (d.name) {
            case 'IsString':  out.type = 'string'; break;
            case 'IsNumber':  out.type = 'number'; break;
            case 'IsInt':     out.type = 'integer'; break;
            case 'IsBoolean': out.type = 'boolean'; break;
            case 'IsDate':    out.type = 'string'; out.format = 'date-time'; break;
            case 'IsArray':   out.type = 'array'; break;
            case 'IsObject':  out.type = 'object'; break;
            case 'IsEmail':   out.type ??= 'string'; out.format = 'email'; break;
            case 'IsUrl':     out.type ??= 'string'; out.format = 'uri'; break;
            case 'IsUUID':    out.type ??= 'string'; out.format = 'uuid'; break;
            case 'IsEnum': {
                const enumValues = parseEnumArg(d.arg);
                if (enumValues.length > 0) {
                    out.type ??= 'string';
                    out.enum = enumValues;
                }
                break;
            }
        }
    }

    return out;
}

function parseFieldDeclarations(body: string): FieldDecl[] {
    const lines = body.split('\n');
    const fields: FieldDecl[] = [];
    let pendingDecorators: Array<{ name: string; arg?: string }> = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

        // Decorator line — may be `@IsString()` or `@IsEnum(MyEnum)`.
        if (line.startsWith('@')) {
            const dec = parseDecoratorLine(line);
            if (dec) pendingDecorators.push(dec);
            continue;
        }

        // Field line — `name: type;`, `name?: type;`, `name: type[]`, `name = ...`.
        const fieldMatch = /^([A-Za-z_$][\w$]*)\??\s*:\s*([^;=]+?)\s*[;=]?$/.exec(line);
        if (fieldMatch) {
            const name = fieldMatch[1];
            const typeAnnotation = fieldMatch[2].trim();
            const optional = line.includes('?:');
            fields.push({
                name,
                decorators: pendingDecorators,
                typeAnnotation,
                optional,
            });
            pendingDecorators = [];
            continue;
        }

        // Standalone field without type (`name;`).
        const bareField = /^([A-Za-z_$][\w$]*)\??\s*;?\s*$/.exec(line);
        if (bareField && pendingDecorators.length > 0) {
            const name = bareField[1];
            const optional = line.includes('?');
            fields.push({ name, decorators: pendingDecorators, optional });
            pendingDecorators = [];
            continue;
        }

        // Anything else (method bodies, statics) breaks the decorator
        // chain so a misplaced decorator doesn't latch onto a method.
        pendingDecorators = [];
    }

    return fields;
}

function parseDecoratorLine(line: string): { name: string; arg?: string } | undefined {
    // `@IsString()` / `@IsEnum(Foo)` / `@IsEnum(['a','b'])` / `@MinLength(3)`
    const m = /^@([A-Za-z_$][\w$]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(line);
    if (!m) return undefined;
    return { name: m[1], arg: m[2]?.trim() || undefined };
}

function parseEnumArg(arg: string | undefined): Array<string | number | boolean | null> {
    if (!arg) return [];
    const trimmed = arg.trim();
    // Inline array form: `@IsEnum(['a','b','c'])`
    const arrMatch = /^\[([\s\S]*?)\]/.exec(trimmed);
    if (arrMatch) {
        return arrMatch[1].split(',')
            .map(s => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
    }
    // Enum identifier — we can't resolve at the parser level. Drop.
    return [];
}

function extractClassBody(source: string, className: string): string | undefined {
    const headerRe = new RegExp(
        `(?:export\\s+)?class\\s+${escapeRe(className)}\\b[^{]*\\{`,
        'm',
    );
    const headerMatch = headerRe.exec(source);
    if (!headerMatch) return undefined;
    const openIdx = headerMatch.index + headerMatch[0].length - 1;
    let depth = 1;
    for (let i = openIdx + 1; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(openIdx + 1, i);
        }
    }
    return undefined;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
