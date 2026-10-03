import { describe, it, expect } from 'vitest';
import { prettifyGraphLabel } from '../prettifyGraphLabel';

describe('prettifyGraphLabel', () => {
    it('maps workspace-scope graphs to friendly names', () => {
        expect(prettifyGraphLabel('microservice:workspace')).toBe('System Design');
        expect(prettifyGraphLabel('map:workspace')).toBe('Knowledge Map');
        expect(prettifyGraphLabel('domain:workspace')).toBe('Business Domains');
        expect(prettifyGraphLabel('tour:workspace')).toBe('Tour');
        expect(prettifyGraphLabel('health:report')).toBe('Health Report');
        expect(prettifyGraphLabel('feature:workspace')).toBe('Feature Areas');
    });

    it('per-service feature graphs', () => {
        expect(prettifyGraphLabel('feature:service:main')).toBe('Features: main');
        expect(prettifyGraphLabel('feature:service:go-gin')).toBe('Features: go-gin');
        expect(prettifyGraphLabel('feature:my-cluster')).toBe('Features: my-cluster');
    });

    it('api-list cluster graphs', () => {
        expect(prettifyGraphLabel('api-list:cluster:article')).toBe('APIs: article');
        expect(prettifyGraphLabel('api-list:auth')).toBe('APIs: auth');
    });

    it('api-list noun adapts to frontend/mobile category → "Entry Points"', () => {
        expect(prettifyGraphLabel('api-list:cluster:screens', undefined, 'frontend')).toBe('Entry Points: screens');
        expect(prettifyGraphLabel('api-list:home', undefined, 'mobile')).toBe('Entry Points: home');
        // backend / omitted keeps "APIs"
        expect(prettifyGraphLabel('api-list:auth', undefined, 'backend')).toBe('APIs: auth');
        expect(prettifyGraphLabel('api-list:auth', undefined, undefined)).toBe('APIs: auth');
    });

    it('anonymous-handler sequence graphs → Sequence: METHOD route', () => {
        expect(prettifyGraphLabel(
            'sequence:src/app/routes/article/article.controller.ts:anonymous@GET:/articles',
        )).toBe('Sequence: GET /articles');

        expect(prettifyGraphLabel(
            'sequence:src/app/routes/auth/auth.controller.ts:anonymous@POST:/users/login',
        )).toBe('Sequence: POST /users/login');
    });

    it('named-handler sequence graphs → Sequence: handler() — file', () => {
        const label = prettifyGraphLabel(
            'sequence:src/app/routes/article/article.controller.ts:getArticles',
        );
        expect(label).toBe('Sequence: getArticles() — article.controller.ts');
    });

    it('flow graphs → Flow: function()', () => {
        expect(prettifyGraphLabel(
            'flow:src/app/routes/article/article.service.ts:getArticles',
        )).toBe('Flow: getArticles()');
        expect(prettifyGraphLabel(
            'flow:src/app/models/http-exception.model.ts:constructor',
        )).toBe('Flow: constructor()');
    });

    it('file graphs → File: basename', () => {
        expect(prettifyGraphLabel('file:src/app/routes/article/article.service.ts'))
            .toBe('File: article.service.ts');
        expect(prettifyGraphLabel('file:plain.js')).toBe('File: plain.js');
    });

    it('unknown prefix falls back to provided label, then graphId', () => {
        expect(prettifyGraphLabel('weird:thing', 'Fallback')).toBe('Fallback');
        expect(prettifyGraphLabel('weird:thing')).toBe('weird:thing');
    });

    it('empty/undefined graphId returns the fallback', () => {
        expect(prettifyGraphLabel('', 'Home')).toBe('Home');
        expect(prettifyGraphLabel(undefined, 'Home')).toBe('Home');
        expect(prettifyGraphLabel(undefined)).toBe('');
    });
});
