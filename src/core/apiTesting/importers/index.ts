/**
 * apiTesting/importers/index.ts — Issue #604 Phase 4.
 *
 * Single entry point for the importer set. Sniffs the format from the
 * parsed JSON object and dispatches. Useful for an MCP tool that
 * receives a blob of spec JSON without prior format knowledge.
 */

import type { ApiTestingPayload } from '../types';
import { importOpenApi } from './openapi';
import { importPostmanCollection } from './postman';
import { importInsomniaExport } from './insomnia';

export type ImportFormat = 'openapi' | 'postman' | 'insomnia' | 'unknown';

export function detectFormat(raw: unknown): ImportFormat {
    if (!raw || typeof raw !== 'object') return 'unknown';
    const obj = raw as Record<string, unknown>;
    if (obj.openapi || obj.swagger || obj.paths) return 'openapi';
    if (obj.info && typeof obj.info === 'object' && (obj.info as Record<string, unknown>)._postman_id) return 'postman';
    if (obj.info && obj.item) return 'postman'; // generic v2.1 shape
    if (obj._type === 'export' || obj.__export_format !== undefined) return 'insomnia';
    return 'unknown';
}

/**
 * Auto-detect the format + dispatch. Returns `null` when the format
 * isn't recognised. The MCP tool surfaces this as a soft error.
 */
export function importApiCollection(raw: unknown): { payload: ApiTestingPayload; format: ImportFormat } | null {
    const format = detectFormat(raw);
    if (format === 'openapi')  return { payload: importOpenApi(raw), format };
    if (format === 'postman')  return { payload: importPostmanCollection(raw), format };
    if (format === 'insomnia') return { payload: importInsomniaExport(raw), format };
    return null;
}

export { importOpenApi } from './openapi';
export { importPostmanCollection } from './postman';
export { importInsomniaExport } from './insomnia';
