import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { getReviewChangedFiles, getUnifiedDiff, getWorkingTreeChangedFiles, getWorkingTreeDiff } from '../gitReader';

// Real tmp-repo integration test for the #review-diff helpers (diff / branch / working-tree).
let ws: string;
const run = (cmd: string) => execSync(cmd, { cwd: ws, stdio: 'pipe' }).toString().trim();

beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'review-diff-'));
    run('git init -q -b main');
    run('git config user.email t@e.com');
    run('git config user.name T');
    run('git config commit.gpgsign false');
    fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
    run('git add -A');
    run('git commit -q -m init');
    run('git checkout -q -b feature');
    fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 2;\n'); // modify
    fs.writeFileSync(path.join(ws, 'b.ts'), 'export const b = 1;\n'); // new file
    run('git add -A');
    run('git commit -q -m feat');
});
afterAll(() => { fs.rmSync(ws, { recursive: true, force: true }); });

describe('#review-diff git helpers', () => {
    it('getReviewChangedFiles lists changed + new files for a branch (by name)', () => {
        const files = getReviewChangedFiles(ws, 'main', 'feature').sort();
        expect(files).toEqual(['a.ts', 'b.ts']);
    });

    it('getReviewChangedFiles works with commit hashes too', () => {
        const base = run('git rev-parse main');
        const head = run('git rev-parse feature');
        expect(getReviewChangedFiles(ws, base, head).sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('getUnifiedDiff returns diff text with +/- markers', () => {
        const d = getUnifiedDiff(ws, 'main', 'feature');
        expect(d).toMatch(/\+export const a = 2;/);
        expect(d).toMatch(/b\.ts/);
    });

    it('getWorkingTreeChangedFiles includes uncommitted edits + untracked files', () => {
        fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 99;\n'); // uncommitted edit
        fs.writeFileSync(path.join(ws, 'c.ts'), 'export const c = 1;\n');  // untracked
        const files = getWorkingTreeChangedFiles(ws);
        expect(files).toContain('a.ts');
        expect(files).toContain('c.ts');
    });

    it('getWorkingTreeDiff returns the +/- working-tree diff vs HEAD', () => {
        const d = getWorkingTreeDiff(ws);
        expect(d).toMatch(/-export const a = 2;/);
        expect(d).toMatch(/\+export const a = 99;/);
    });

    it('invalid / injection refs return empty safely', () => {
        expect(getReviewChangedFiles(ws, 'bad; rm -rf /', 'feature')).toEqual([]);
        expect(getUnifiedDiff(ws, 'feature', 'no$pe')).toBe('');
    });
});
