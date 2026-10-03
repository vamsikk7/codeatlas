import { describe, it, expect } from 'vitest';
import { collectTopLevelEntities } from '../symbolExtractor';

describe('class method extraction (issues 263, 290)', () => {
    it('Issue 290: populates calls set for ClassMethod entities', () => {
        const code = `
function helper() { return 42; }

export class Service {
    run() {
        return helper();
    }
    runTwice() {
        return helper() + helper();
    }
}
`;
        const a = collectTopLevelEntities(code, 'service.ts');
        const run = a.funcs.get('Service.run');
        expect(run).toBeDefined();
        expect(Array.from(run!.calls ?? [])).toContain('helper');
        const runTwice = a.funcs.get('Service.runTwice');
        expect(runTwice).toBeDefined();
        expect(Array.from(runTwice!.calls ?? [])).toContain('helper');
    });

    it('populates calls and usesImports for ClassMethod entities', () => {
        const code = `
import { ArticleService } from './article.service';
import { logger } from './logger';

export class ArticleController {
    constructor(private svc: ArticleService) {}
    async findAll() {
        logger.info('listing');
        return this.svc.findAll();
    }
    async create(body: any) {
        logger.info('creating');
        return this.svc.create(body);
    }
}
`;
        const a = collectTopLevelEntities(code, 'article.controller.ts');
        const findAll = a.funcs.get('ArticleController.findAll');
        expect(findAll).toBeDefined();
        expect(Array.from(findAll!.usesImports ?? [])).toContain('logger');
        const create = a.funcs.get('ArticleController.create');
        expect(create).toBeDefined();
        expect(Array.from(create!.usesImports ?? [])).toContain('logger');
    });
});
