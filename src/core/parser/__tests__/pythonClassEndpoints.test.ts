/**
 * pythonClassEndpoints.test.ts — #877
 *
 * Class-based HTTP endpoints (Django REST APIView / Sentry endpoint hierarchy)
 * and Sentry's `@instrumented_task` background jobs. These are the real
 * detector misses found by the benchmark dry-run triage: sentry PRs that
 * changed endpoint/task files extracted 0 entry points because the detector
 * only knew decorator routes + urls.py call forms, never endpoint base classes.
 */
import { describe, it, expect } from 'vitest';
import { detectFrameworkApis } from '../frameworkDetector';

const SENTRY_ENDPOINT = `
from sentry.api.base import control_silo_endpoint
from sentry.api.bases.organization import ControlSiloOrganizationEndpoint


@control_silo_endpoint
class OrganizationAuditLogsEndpoint(ControlSiloOrganizationEndpoint):
    owner = ApiOwner.ENTERPRISE

    def get(self, request: Request, organization_context, organization) -> Response:
        return self.paginate(request)

    def post(self, request: Request, organization) -> Response:
        return Response(status=201)
`;

describe('#877 — Python class-based endpoints + @instrumented_task', () => {
    it('detects a Sentry-style class endpoint and emits one entry per HTTP verb', () => {
        const apis = detectFrameworkApis(SENTRY_ENDPOINT, 'src/sentry/api/endpoints/organization_auditlogs.py', 'python');
        const methods = apis.map((a) => a.method).sort();
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        // Anchored to the endpoint FILE (so a PR editing the handler matches it).
        const ep = apis.find((a) => a.method === 'GET');
        expect(ep?.filePath).toBe('src/sentry/api/endpoints/organization_auditlogs.py');
        expect(ep?.handlerName).toBe('OrganizationAuditLogsEndpoint');
        // Stable route synthesised from the class name (kebab-cased, no `Endpoint`).
        expect(ep?.route).toBe('/organization-audit-logs');
    });

    it('detects a plain DRF APIView subclass (no silo decorator)', () => {
        const src = `
class UserDetailEndpoint(Endpoint):
    def get(self, request, user_id):
        return Response()

    def delete(self, request, user_id):
        return Response(status=204)
`;
        const apis = detectFrameworkApis(src, 'app/api/users.py', 'python');
        expect(apis.map((a) => a.method).sort()).toEqual(['DELETE', 'GET']);
    });

    it('#902 — detects a verb method PAST the old 4000-char window; sibling not credited', () => {
        // FooEndpoint has a `def patch` ~5000 chars into the body (a long
        // comment block pushes it past the old fixed 4000-char slice). BarEndpoint
        // follows with its own verb — Foo must NOT be credited Bar's verbs.
        const filler = Array.from({ length: 60 }, (_, i) => `    # padding line ${i} ${'x'.repeat(60)}`).join('\n');
        const src = `
class FooEndpoint(Endpoint):
    def get(self, request):
        return Response()
${filler}
    def patch(self, request):
        return Response()

class BarEndpoint(Endpoint):
    def delete(self, request):
        return Response()
`;
        // sanity: the patch def really is past 4000 chars from the class body start
        expect(src.indexOf('def patch')).toBeGreaterThan(src.indexOf('class FooEndpoint') + 4000);
        const apis = detectFrameworkApis(src, 'app/api/foo.py', 'python');
        // Each verb is emitted as its own record (same shape as the #877 test).
        const fooVerbs = apis.filter((a) => a.handlerName === 'FooEndpoint').map((a) => a.method).sort();
        const barVerbs = apis.filter((a) => a.handlerName === 'BarEndpoint').map((a) => a.method).sort();
        expect(fooVerbs).toEqual(['GET', 'PATCH']);      // PATCH past 4000 now detected
        expect(barVerbs).toEqual(['DELETE']);            // sibling not credited Foo's verbs
        expect(fooVerbs).not.toContain('DELETE');
    });

    it('does NOT match a non-HTTP *Endpoint class (no def verb(self, request))', () => {
        // ORM/strategy classes whose base merely contains "Endpoint" must not
        // be mistaken for HTTP endpoints — guards against false positives.
        const src = `
class KafkaEndpoint(BaseEndpoint):
    def configure(self, options):
        self.bootstrap = options["bootstrap"]

    def connect(self):
        return True
`;
        const apis = detectFrameworkApis(src, 'app/streams/kafka.py', 'python');
        expect(apis.filter((a) => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.method))).toHaveLength(0);
    });

    it('detects @instrumented_task as a JOB entry point', () => {
        const src = `
from sentry.tasks.base import instrumented_task


@instrumented_task(
    name="sentry.integrations.tasks.sync_assignee_outbound",
    queue="integrations",
    silo_mode=SiloMode.REGION,
)
def sync_assignee_outbound(external_issue_id, user_id, assign=True):
    do_work()
`;
        const apis = detectFrameworkApis(src, 'src/sentry/integrations/tasks/sync_assignee_outbound.py', 'python');
        const job = apis.find((a) => a.method === 'JOB');
        expect(job).toBeDefined();
        expect(job?.handlerName).toBe('sync_assignee_outbound');
        // The detector normalises routes to a leading slash.
        expect(job?.route).toBe('/task:sync_assignee_outbound');
    });
});
