/**
 * classValidator.test.ts — Issue #600 Phase 0 class-validator inference.
 */

import { describe, it, expect } from 'vitest';
import { parseClassValidatorDto, parseClassValidatorInferredApiSchema } from '../classValidator';

describe('parseClassValidatorDto', () => {
    it('extracts decorated fields with types + required[]', () => {
        const src = `
            export class CreateArticleDto {
                @IsString()
                title: string;

                @IsString()
                @IsOptional()
                description?: string;

                @IsBoolean()
                published: boolean;
            }
        `;
        const out = parseClassValidatorDto(src, 'CreateArticleDto');
        expect(out?.type).toBe('object');
        expect(out?.properties?.title?.type).toBe('string');
        expect(out?.properties?.published?.type).toBe('boolean');
        expect(out?.properties?.description?.nullable).toBe(true);
        expect(out?.required?.sort()).toEqual(['published', 'title']);
    });

    it('lifts format hints from @IsEmail / @IsUrl / @IsUUID', () => {
        const src = `
            export class UserDto {
                @IsEmail()
                email: string;

                @IsUrl()
                website: string;

                @IsUUID()
                id: string;
            }
        `;
        const out = parseClassValidatorDto(src, 'UserDto');
        expect(out?.properties?.email?.format).toBe('email');
        expect(out?.properties?.website?.format).toBe('uri');
        expect(out?.properties?.id?.format).toBe('uuid');
    });

    it('lifts string[] / number[] arrays from TS type annotation', () => {
        const src = `
            export class TagDto {
                @IsArray()
                tags: string[];

                @IsArray()
                scores: number[];
            }
        `;
        const out = parseClassValidatorDto(src, 'TagDto');
        expect(out?.properties?.tags?.type).toBe('array');
        expect(out?.properties?.tags?.items?.type).toBe('string');
        expect(out?.properties?.scores?.items?.type).toBe('number');
    });

    it('handles @IsEnum with inline array literal', () => {
        const src = `
            export class FilterDto {
                @IsEnum(['active','archived','deleted'])
                status: string;
            }
        `;
        const out = parseClassValidatorDto(src, 'FilterDto');
        expect(out?.properties?.status?.enum).toEqual(['active', 'archived', 'deleted']);
    });

    it('falls back to type=string with description when @IsEnum references an identifier', () => {
        const src = `
            export class StatusDto {
                @IsEnum(MyEnum)
                value: string;
            }
        `;
        const out = parseClassValidatorDto(src, 'StatusDto');
        // Identifier-as-arg can't be resolved at parse time — keep base type
        expect(out?.properties?.value?.type).toBe('string');
        expect(out?.properties?.value?.enum).toBeUndefined();
    });

    it('returns undefined for missing class', () => {
        expect(parseClassValidatorDto('class Other {}', 'Missing')).toBeUndefined();
    });
});

describe('parseClassValidatorInferredApiSchema', () => {
    it('wraps a DTO into a request-schema payload', () => {
        const src = `
            export class LoginDto {
                @IsString()
                email: string;
                @IsString()
                password: string;
            }
        `;
        const out = parseClassValidatorInferredApiSchema(src, 'LoginDto');
        expect(out.requestSchema?.kind).toBe('json');
        expect(out.requestSchema?.source).toBe('class-validator');
        expect(out.requestSchema?.schema?.required?.sort()).toEqual(['email', 'password']);
    });

    it('returns empty for unknown class', () => {
        expect(parseClassValidatorInferredApiSchema('class Other {}', 'Missing')).toEqual({});
    });
});
