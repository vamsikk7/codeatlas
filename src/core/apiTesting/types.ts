/**
 * apiTesting/types.ts — Issue #601 Phase 1 shared types.
 *
 * Each detected `ApiRecord` is transformed into one
 * `ApiTestingEndpoint` for the read-only request browser. Endpoints
 * are grouped into `ApiTestingCollection`s by L2a cluster.
 *
 * The shape is intentionally serialisable so the same payload flows
 * from the extension/standalone into the webview via WS / postMessage
 * without any custom encoding.
 */

import type { JsonSchemaLike } from '../graph/graphTypes';

export interface ApiTestingPathParam {
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
}

export interface ApiTestingQueryParam {
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
}

export interface ApiTestingResponse {
    status: number;
    description?: string;
    schema?: JsonSchemaLike;
}

export interface ApiTestingEndpoint {
    /** Stable id — same shape as ApiRecord.apiId so deep-links roundtrip. */
    id: string;
    /** HTTP / synthetic method (`GET`, `POST`, `WS`, `JOB`, …). */
    method: string;
    /** Route as written (`/api/articles/:id`). */
    route: string;
    /** Handler name + file basename for the row subtitle. */
    handlerName: string;
    filePath: string;
    /** Hint from L2b — `'required'` / `'optional'` / undefined. */
    auth?: 'required' | 'optional';
    /** True when L2b detected a webhook handler (provider in `webhookProvider`). */
    webhook?: boolean;
    webhookProvider?: string;
    /** Path / query / body / response schemas, lifted from #600 inferrers. */
    pathParams?: ApiTestingPathParam[];
    queryParams?: ApiTestingQueryParam[];
    requestSchema?: {
        kind: 'json' | 'form' | 'multipart' | 'raw';
        schema?: JsonSchemaLike;
        source: 'jsdoc' | 'zod' | 'joi' | 'yup' | 'class-validator' | 'ts-type';
    };
    responseSchema?: ApiTestingResponse[];
    /** Middleware chain (auth, logging, etc.) — used by the right pane. */
    middlewares?: string[];
}

export interface ApiTestingCollection {
    /** Stable id, e.g. `cluster:auth`. */
    id: string;
    /** Display label, defaulting to the cluster name. */
    label: string;
    /** Source — `'l2a-cluster'` for auto-derived; `'manual'` for user-curated. */
    source: 'l2a-cluster' | 'manual';
    endpoints: ApiTestingEndpoint[];
}

export interface ApiTestingPayload {
    /** Total endpoint count across all collections. */
    totalEndpoints: number;
    /** Collections grouped by L2a cluster, sorted by endpoint count DESC. */
    collections: ApiTestingCollection[];
}
