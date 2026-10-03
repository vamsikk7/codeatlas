/**
 * capture-gifs.spec.ts
 *
 * Playwright test that captures screenshot frames for GIF generation.
 * Run: cd e2e && npx playwright test capture-gifs
 *
 * Then convert to GIF:
 *   ffmpeg -framerate 2 -i e2e/screenshots/timeline-replay/frame-%03d.png \
 *     -vf "scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
 *     docs/diagrams/timeline-replay.gif
 *
 *   ffmpeg -framerate 1.5 -i e2e/screenshots/comments/frame-%03d.png \
 *     -vf "scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
 *     docs/diagrams/comments.gif
 */

import { test } from '../fixtures/server';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOT_BASE = path.resolve(__dirname, '..', 'screenshots');

test.describe('GIF Capture — Timeline Replay', () => {
    test('capture timeline replay frames', async ({ page, serverUrl }) => {
        const dir = path.join(SCREENSHOT_BASE, 'timeline-replay');
        fs.mkdirSync(dir, { recursive: true });
        let frame = 0;
        const shot = async () => {
            await page.screenshot({ path: path.join(dir, `frame-${String(frame++).padStart(3, '0')}.png`) });
        };

        // Frame 0: System Design
        await page.goto(`${serverUrl}#/system-design`);
        await page.waitForSelector('.react-flow__node', { timeout: 15000 });
        await page.waitForTimeout(500);
        await shot();

        // Frame 1: Click Timeline Replay → picker opens
        await page.locator('.ca-command-bar-btn[title="Timeline Replay"]').click();
        await page.waitForSelector('.ca-modal-overlay', { timeout: 5000 });
        await page.waitForTimeout(300);
        await shot();

        // Frame 2: Select start commit
        const commits = page.locator('.ca-modal >> div[style*="cursor: pointer"]');
        await commits.first().click();
        await page.waitForTimeout(200);
        await shot();

        // Frame 3: Select end commit (range highlighted)
        await commits.nth(3).click();
        await page.waitForTimeout(200);
        await shot();

        // Frame 4: Click Start Replay
        await page.getByText(/Start Replay/).click();
        await page.waitForTimeout(600);
        await shot();

        // Frames 5-10: Replay steps auto-advance
        for (let i = 0; i < 6; i++) {
            await page.waitForTimeout(400);
            await shot();
        }

        // Frame 11: Replay finishing
        await page.waitForTimeout(2000);
        await shot();

        console.log(`Timeline replay: ${frame} frames → ${dir}`);
    });
});

test.describe('GIF Capture — Comments', () => {
    test('capture comment flow frames', async ({ page, serverUrl }) => {
        const dir = path.join(SCREENSHOT_BASE, 'comments');
        fs.mkdirSync(dir, { recursive: true });
        let frame = 0;
        const shot = async () => {
            await page.screenshot({ path: path.join(dir, `frame-${String(frame++).padStart(3, '0')}.png`) });
        };

        // Auto-accept prompt() dialogs with a comment body
        page.on('dialog', async dialog => {
            await dialog.accept('This function needs error handling for expired tokens');
        });

        // Frame 0: Navigate to file diagram (nodes have anchors for commenting)
        await page.goto(`${serverUrl}#/file/src/auth/login.ts`);
        await page.waitForSelector('.react-flow__node', { timeout: 15000 });
        await page.waitForTimeout(800);
        await shot();

        // Frame 1: Right-click the loginHandler node (the modified one — most prominent)
        const loginNode = page.locator('.react-flow__node', { hasText: 'loginHandler' });
        await loginNode.click({ button: 'right' });
        await page.waitForSelector('.ca-context-menu', { timeout: 3000 });
        await page.waitForTimeout(400);
        await shot();

        // Frame 2: Click "Add comment" → prompt auto-accepted
        await page.getByText('Add comment').click();
        await page.waitForTimeout(600);
        await shot();

        // Frame 3: Wait for updateGraph with commentCount + notification toast
        await page.waitForTimeout(800);
        await shot();

        // Frame 4: Hold — showing 💬 badge on loginHandler
        await page.waitForTimeout(600);
        await shot();

        // Frame 5: Extra hold for GIF loop
        await page.waitForTimeout(500);
        await shot();

        console.log(`Comments: ${frame} frames → ${dir}`);
    });
});
