/**
 * schemaInference/types.ts — Issue #600 shared types for the schema
 * inference modules. Each per-source parser (`jsdoc.ts`, `zod.ts`,
 * `joi.ts`, `classValidator.ts`, `tsType.ts`) emits the same
 * `InferredApiSchema` shape so the framework detector can merge results
 * from multiple sources into a single `ApiRecord.meta.*` payload.
 */

import type { JsonSchemaLike } from '../../graph/graphTypes';

export interface InferredApiSchema {
    pathParams?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
    queryParams?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
    requestSchema?: {
        kind: 'json' | 'form' | 'multipart' | 'raw';
        schema?: JsonSchemaLike;
        source: 'jsdoc' | 'zod' | 'joi' | 'yup' | 'class-validator' | 'ts-type';
    };
    responseSchema?: Array<{
        status: number;
        schema?: JsonSchemaLike;
        source: 'jsdoc' | 'inferred';
        description?: string;
    }>;
}

export type SchemaInferenceSource = NonNullable<InferredApiSchema['requestSchema']>['source'];
