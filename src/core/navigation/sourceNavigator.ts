import type { Anchor } from '../graph/graphTypes';

/**
 * Resolves diagram element anchors to current file positions.
 * Used for navigating from diagram to source and re-anchoring comments.
 */
export class AnchorResolver {
    /**
     * Resolve an anchor to the best matching position
     */
    resolve(anchor: Anchor, currentCode?: string): { filePath: string; line?: number; column?: number } | null {
        if (!anchor.filePath) return null;

        const result: { filePath: string; line?: number; column?: number } = {
            filePath: anchor.filePath,
        };

        if (anchor.span && currentCode) {
            const pos = this.offsetToLineColumn(currentCode, anchor.span.start);
            result.line = pos.line;
            result.column = pos.column;
        }

        return result;
    }

    /**
     * Convert byte offset to line/column
     */
    private offsetToLineColumn(code: string, offset: number): { line: number; column: number } {
        let line = 1;
        let column = 0;
        for (let i = 0; i < offset && i < code.length; i++) {
            if (code[i] === '\n') {
                line++;
                column = 0;
            } else {
                column++;
            }
        }
        return { line, column };
    }
}

/**
 * Navigate to a source code location from a diagram element.
 */
export class SourceNavigator {
    private anchorResolver: AnchorResolver;

    constructor() {
        this.anchorResolver = new AnchorResolver();
    }

    /**
     * Get the file path and position for a diagram element's anchor
     */
    getSourceLocation(anchor: Anchor, currentCode?: string) {
        return this.anchorResolver.resolve(anchor, currentCode);
    }
}
