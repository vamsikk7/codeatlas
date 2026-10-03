/**
 * samRouteExtractor.ts - UX-24 (2026-06-04)
 *
 * Parse AWS SAM templates (`template.yaml` / `template.yml`) into the
 * canonical `ApiRecord` shape so HTTP routes declared as
 * `Resources.<Fn>.Type === 'AWS::Serverless::Function'` with
 * `Events.<X>.Type === 'Api' | 'HttpApi'` show up alongside framework-
 * detected routes in the L2b API list / L3 sequence / L1 system design.
 *
 * Scope: HTTP routes only. Non-HTTP event types (S3, SQS, Schedule,
 * EventBridge, DynamoDB Streams, Cognito, etc.) are intentionally
 * skipped here — the existing `JOB` / `MQ_CONSUMER` / `BG_TASK` detection
 * (CLAUDE.md §"Non-API entry-point detection") covers those for
 * framework code, and adding YAML-derived versions of every category
 * widens the blast radius. Defer to a follow-up if/when we need it.
 */

import * as yaml from 'js-yaml';
import * as path from 'path';
import type { ApiRecord, Anchor } from '../graph/graphTypes';

const HTTP_EVENT_TYPES = new Set(['Api', 'HttpApi']);

/**
 * CloudFormation intrinsic-function tags (`!Ref`, `!Sub`, `!GetAtt`, etc.)
 * are SAM/CFN extensions to YAML. `js-yaml`'s default schema doesn't know
 * them and throws. We define a tolerant schema that resolves every CFN
 * intrinsic to a placeholder string — we don't need the actual value
 * (this extractor only cares about Path / Method / Handler literals).
 */
const CFN_INTRINSICS = [
    'Ref', 'Sub', 'GetAtt', 'Join', 'Split', 'Select', 'FindInMap',
    'Base64', 'Cidr', 'GetAZs', 'ImportValue', 'Transform', 'And', 'Or',
    'Not', 'Equals', 'If', 'Condition', 'ToJsonString', 'Length',
];

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
    CFN_INTRINSICS.flatMap((name) => [
        new yaml.Type(`!${name}`, { kind: 'scalar', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'sequence', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
        new yaml.Type(`!${name}`, { kind: 'mapping', construct: (d: any) => ({ ['Fn::' + name]: d }) }),
    ]),
);

/**
 * Returns true if the given path looks like a SAM template. Used by the
 * dispatcher to route `template.yaml` files to this extractor instead
 * of treating them as a regular YAML file (which we don't parse).
 */
export function isSamTemplatePath(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    return base === 'template.yaml' || base === 'template.yml';
}

/**
 * Parse the SAM template text into ApiRecord rows. Returns [] on any
 * load error - we never throw out into the caller because a malformed
 * YAML in an unrelated file shouldn't crash the whole indexer.
 */
export function parseSamTemplate(yamlText: string, templateFilePath: string): ApiRecord[] {
    if (!yamlText || !yamlText.trim()) return [];

    let doc: any;
    try {
        doc = yaml.load(yamlText, { schema: CFN_SCHEMA });
    } catch {
        return [];
    }
    if (!doc || typeof doc !== 'object') return [];

    const resources = (doc as any).Resources;
    if (!resources || typeof resources !== 'object') return [];

    // SAM allows `Globals.Function.{Handler,Runtime,CodeUri}` to set
    // defaults for every AWS::Serverless::Function in the template.
    // Many real-world templates only declare the per-function override
    // when it differs — without merging Globals, our handler-file
    // resolution falls back to a bogus `handler.js` placeholder.
    const globals = ((doc as any).Globals ?? {}) as any;
    const globalsFn = (globals.Function ?? {}) as any;
    const defaultHandler = String(globalsFn.Handler ?? '');
    const defaultRuntime = String(globalsFn.Runtime ?? '');
    const defaultCodeUri = String(globalsFn.CodeUri ?? '');

    const templateDir = path.dirname(templateFilePath);
    const records: ApiRecord[] = [];

    for (const [logicalName, resource] of Object.entries(resources)) {
        if (!resource || typeof resource !== 'object') continue;
        const r = resource as any;
        if (r.Type !== 'AWS::Serverless::Function') continue;
        const props = r.Properties;
        if (!props || typeof props !== 'object') continue;

        const events = props.Events;
        if (!events || typeof events !== 'object') continue;

        const handlerFilePath = resolveHandlerFilePath(
            templateDir,
            String(props.CodeUri ?? defaultCodeUri ?? ''),
            String(props.Handler ?? defaultHandler ?? ''),
            String(props.Runtime ?? defaultRuntime ?? ''),
        );

        let eventIndex = 0;
        for (const [eventName, eventDef] of Object.entries(events)) {
            if (!eventDef || typeof eventDef !== 'object') continue;
            const ev = eventDef as any;
            const eventType = String(ev.Type ?? '');
            if (!HTTP_EVENT_TYPES.has(eventType)) continue;
            const evProps = (ev.Properties ?? {}) as any;

            const rawPath = String(evProps.Path ?? '').trim();
            const rawMethod = String(evProps.Method ?? '').trim();
            // SAM HttpApi default: when Path + Method are omitted, the
            // event acts as a catch-all (`$default` route, ANY method).
            // Render that as `ANY /$default` so the route is visible
            // instead of silently skipped.
            let method: string;
            let route: string;
            if (!rawPath && !rawMethod) {
                if (eventType !== 'HttpApi') continue;
                method = 'ANY';
                route = '/$default';
            } else if (!rawPath || !rawMethod) {
                // Partial event (one of Path/Method missing) — skip;
                // malformed definitions shouldn't manifest as half-routes.
                continue;
            } else {
                method = rawMethod.toUpperCase();
                route = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
            }

            // 2026-06-09 — see serverlessFrameworkRouteExtractor for the
            // monorepo collision rationale. Prefix with the handler's
            // top-level directory so identical logicalName+route in two
            // sub-repos stay distinct in the workspace apiIndex.
            const samNorm = handlerFilePath.replace(/\\/g, '/');
            const samFirstSlash = samNorm.indexOf('/');
            const samPrefix = samFirstSlash > 0 ? `${samNorm.slice(0, samFirstSlash)}:` : '';
            const apiId = `sam:${samPrefix}${logicalName}:${method}:${route}:${eventIndex++}`;
            const anchor: Anchor = {
                filePath: handlerFilePath,
                lineStart: 1,
                lineEnd: 1,
            };

            records.push({
                apiId,
                method,
                route,
                handlerName: logicalName,
                filePath: handlerFilePath,
                anchor,
                meta: {
                    // Tag the source so downstream renderers / tour builder /
                    // L2b can mark these routes distinctly if they ever need to.
                    // `webhook` / `auth` / etc. stay undefined — SAM templates
                    // don't expose those signals in the same shape.
                },
            } as ApiRecord);
        }
    }

    return records;
}

function resolveHandlerFilePath(
    templateDir: string,
    codeUri: string,
    handler: string,
    runtime: string,
): string {
    // Handler shape varies by runtime:
    //   - Node.js: `app.lambdaHandler`           → file `app.js` (or `.ts`/`.mjs`)
    //   - Python:  `module.function_name`        → file `module.py`
    //   - Go:      `main` or `bootstrap`         → file `main.go`
    //   - Java:    `com.example.App::handleRequest` → file `com/example/App.java`
    //   - Ruby:    `app.handler`                 → file `app.rb`
    //   - .NET:    `Assembly::Namespace.Class::Method` → file matched on Class
    //
    // We use Runtime as the primary hint for extension. When CodeUri is set,
    // it's relative to the template dir and the handler file lives inside.
    const base = codeUri ? path.join(templateDir, normaliseCodeUri(codeUri)) : templateDir;

    const ext = extensionForRuntime(runtime);
    if (!handler) {
        // Best effort: synthesize a placeholder so the anchor still points
        // into the right directory.
        return path.join(base, `handler${ext}`);
    }

    // Java handler format `com.example.App::handleRequest` → `com/example/App.java`
    if (ext === '.java' || /^java/i.test(runtime)) {
        const beforeColon = handler.split('::')[0];
        const dotted = beforeColon.split('.');
        const className = dotted.pop();
        return path.join(base, ...dotted, `${className}.java`);
    }

    // .NET handler format `Assembly::Namespace.Class::Method`
    if (/^dotnet/i.test(runtime)) {
        const parts = handler.split('::');
        // Use the assembly (parts[0]) as a top-level dir + the class as the filename.
        const klass = parts[1]?.split('.').pop() ?? 'Handler';
        return path.join(base, `${klass}.cs`);
    }

    // Go: handler is usually `main` or `bootstrap` — file is conventionally `main.go`.
    if (ext === '.go') {
        return path.join(base, 'main.go');
    }

    // Node/Python/Ruby: handler is `file.exportName` → strip the export.
    const fileStem = handler.split('.').slice(0, -1).join('.') || handler;
    return path.join(base, `${fileStem}${ext}`);
}

function normaliseCodeUri(codeUri: string): string {
    // Strip a trailing slash for cleaner path.join behaviour.
    return codeUri.replace(/\/+$/, '');
}

function extensionForRuntime(runtime: string): string {
    const r = runtime.toLowerCase();
    if (r.startsWith('python')) return '.py';
    if (r.startsWith('go')) return '.go';
    if (r.startsWith('java')) return '.java';
    if (r.startsWith('dotnet')) return '.cs';
    if (r.startsWith('ruby')) return '.rb';
    if (r.startsWith('provided')) return '.sh';
    // Default to JS — covers `nodejs*`, undeclared runtime, and TypeScript
    // (the source is JS once compiled).
    return '.js';
}
