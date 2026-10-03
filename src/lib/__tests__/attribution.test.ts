/**
 * The attribution string is a product requirement, not decoration: it is how
 * CodeAtlas gets discovered from artifacts that are pasted into PRs, wikis and
 * AI assistant context. These tests pin the wording so a refactor cannot
 * silently drop or reword it.
 */
import { describe, it, expect } from 'vitest';
import {
    PRODUCT_NAME, PRODUCT_URL, ATTRIBUTION_TEXT,
    ATTRIBUTION_MARKDOWN, markdownAttributionFooter,
} from '../attribution';

describe('attribution', () => {
    it('names the product and the canonical URL', () => {
        expect(PRODUCT_NAME).toBe('CodeAtlas');
        expect(PRODUCT_URL).toBe('https://codeatlas.live');
    });

    it('plain-text form carries both name and URL', () => {
        expect(ATTRIBUTION_TEXT).toContain('Powered by CodeAtlas');
        expect(ATTRIBUTION_TEXT).toContain(PRODUCT_URL);
    });

    it('markdown form is a real link', () => {
        expect(ATTRIBUTION_MARKDOWN).toBe('Powered by [CodeAtlas](https://codeatlas.live)');
    });

    it('footer is separated from preceding content', () => {
        const f = markdownAttributionFooter();
        expect(f).toContain('---');
        expect(f).toContain(ATTRIBUTION_MARKDOWN);
    });
});
