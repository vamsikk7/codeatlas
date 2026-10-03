/**
 * k8s.test.ts — Issue #705 Phase 2 Kubernetes manifest parser.
 */

import { describe, it, expect } from 'vitest';
import { canParseK8s, parseK8s } from '../k8s';

describe('canParseK8s', () => {
    it('matches any YAML extension', () => {
        expect(canParseK8s('deploy/app.yaml')).toBe(true);
        expect(canParseK8s('deploy/app.yml')).toBe(true);
        expect(canParseK8s('k8s/Deployment.YAML')).toBe(true);
    });

    it('rejects non-yaml files', () => {
        expect(canParseK8s('Dockerfile')).toBe(false);
        expect(canParseK8s('package.json')).toBe(false);
    });
});

describe('parseK8s', () => {
    it('returns no records for non-K8s YAML', () => {
        const src = 'foo: bar\nbaz: qux\n';
        expect(parseK8s('config/app.yaml', src)).toEqual([]);
    });

    it('extracts a single Deployment with name + image dep', () => {
        const src = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  name: web',
            '  namespace: prod',
            'spec:',
            '  selector:',
            '    matchLabels:',
            '      app: web',
            '  template:',
            '    spec:',
            '      containers:',
            '      - name: web',
            '        image: ghcr.io/example/web:1.2.3',
        ].join('\n');
        const recs = parseK8s('deploy/web.yaml', src);
        expect(recs).toHaveLength(1);
        expect(recs[0].kind).toBe('k8s-deployment');
        expect(recs[0].name).toBe('web');
        expect(recs[0].id).toBe('infra:k8s-deployment:deploy/web.yaml::prod/web');
        expect(recs[0].meta?.namespace).toBe('prod');
        expect(recs[0].meta?.selectorLabels).toEqual({ app: 'web' });
        expect(recs[0].dependencies).toContain('k8s:image-ref:ghcr.io/example/web:1.2.3');
    });

    it('splits multi-document YAML into separate records', () => {
        const src = [
            'apiVersion: apps/v1',
            'kind: Deployment',
            'metadata:',
            '  name: api',
            '---',
            'apiVersion: v1',
            'kind: Service',
            'metadata:',
            '  name: api',
        ].join('\n');
        const recs = parseK8s('all.yaml', src);
        expect(recs.map(r => r.kind).sort()).toEqual(['k8s-deployment', 'k8s-service']);
    });

    it('handles Ingress + CronJob kinds', () => {
        const src = [
            'kind: Ingress',
            'metadata:',
            '  name: gateway',
            '---',
            'kind: CronJob',
            'metadata:',
            '  name: nightly',
            'spec:',
            '  jobTemplate:',
            '    spec:',
            '      template:',
            '        spec:',
            '          containers:',
            '          - image: ghcr.io/example/nightly:latest',
        ].join('\n');
        const recs = parseK8s('manifests.yaml', src);
        expect(recs.map(r => r.kind).sort()).toEqual(['k8s-cronjob', 'k8s-ingress']);
        const cron = recs.find(r => r.kind === 'k8s-cronjob')!;
        expect(cron.dependencies).toContain('k8s:image-ref:ghcr.io/example/nightly:latest');
    });

    it('ignores docs lacking metadata.name', () => {
        const src = 'kind: Deployment\nmetadata:\n  labels:\n    app: foo\n';
        expect(parseK8s('bad.yaml', src)).toEqual([]);
    });

    it('ignores unknown kinds', () => {
        const src = 'kind: ConfigMap\nmetadata:\n  name: settings\n';
        expect(parseK8s('cm.yaml', src)).toEqual([]);
    });
});
