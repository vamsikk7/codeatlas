/**
 * schemaInference/index.ts — Issue #600 facade.
 *
 * Phase 0 exports the JSDoc + Zod parsers. Joi, Yup, class-validator,
 * and ts-type inference can be added incrementally without changing
 * the facade — each module is independent + only the framework
 * detector decides which parser to invoke for a given handler.
 */

export { parseJsdocSchema } from './jsdoc';
export { parseZodExport, parseZodExpression, parseZodInferredApiSchema } from './zod';
export { parseJoiExport, parseJoiExpression, parseJoiInferredApiSchema } from './joi';
export { parseYupExport, parseYupExpression, parseYupInferredApiSchema } from './yup';
export { parseClassValidatorDto, parseClassValidatorInferredApiSchema } from './classValidator';
export { parseTsHandlerSchema } from './tsType';
export type { InferredApiSchema, SchemaInferenceSource } from './types';
