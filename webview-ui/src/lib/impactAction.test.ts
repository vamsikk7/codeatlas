import { describe, it, expect } from 'vitest';
import { impactActionForGraphId } from './impactAction';

describe('impactActionForGraphId (BUG-EXPLORE-7)', () => {
    it('runs impact directly on the current FILE view', () => {
        expect(impactActionForGraphId('file:src/app/routes/article/article.controller.ts'))
            .toEqual({ type: 'requestImpact', filePath: 'src/app/routes/article/article.controller.ts' });
    });
    it('runs impact on the FLOW view\'s file (handler name may contain colons)', () => {
        expect(impactActionForGraphId('flow:src/x.ts:anonymous@GET:/articles'))
            .toEqual({ type: 'requestImpact', filePath: 'src/x.ts' });
    });
    it('runs impact on the SEQUENCE view\'s file', () => {
        expect(impactActionForGraphId('sequence:src/y.ts:findAll'))
            .toEqual({ type: 'requestImpact', filePath: 'src/y.ts' });
    });
    it('falls back to the file picker for non-file views (L1/L2/health)', () => {
        expect(impactActionForGraphId('microservice:workspace'))
            .toEqual({ type: 'runCommand', command: 'codeatlas.analyzeImpact' });
        expect(impactActionForGraphId('feature:workspace'))
            .toEqual({ type: 'runCommand', command: 'codeatlas.analyzeImpact' });
        expect(impactActionForGraphId(null))
            .toEqual({ type: 'runCommand', command: 'codeatlas.analyzeImpact' });
    });
});
