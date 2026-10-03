import { test, expect } from '../fixtures/server';

test.describe('Home Page', () => {
    test('renders with CodeAtlas title and stats', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });

        await expect(page.locator('.ca-home-title')).toContainText('CodeAtlas');
        await expect(page.locator('.ca-home-stats')).toBeVisible();
        // workspaceInfo sends fileCount=42
        await expect(page.locator('.ca-home-stat-value').first()).toHaveText('42');
    });

    test('shows connection status as connected', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home-status.connected', { timeout: 10000 });
        await expect(page.locator('.ca-home-status')).toContainText('Connected');
    });

    test('renders all section headings', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        const sections = page.locator('.ca-section-label');
        const texts = await sections.allTextContents();
        const normalized = texts.map(t => t.toLowerCase());
        expect(normalized).toContain('diagrams');
        expect(normalized).toContain('tools');
    });

    test('renders command cards for all major features', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        // (9.1.49) The 'Feature Areas', 'Compare Commits', 'Branch Diff', and
        // 'PR Diff' HOME cards were intentionally removed — those flows are now
        // reached from the in-diagram CommandBar toolbar (Feature Areas also via
        // drilling from L1). The Diagrams section now leads with the per-layer
        // drill and ends with the whole-codebase overviews (Knowledge Map,
        // Domains). The git section is the Replay family + GitHub.
        // Scope to card titles — some labels (e.g. "Sequence") also appear as
        // a stats label ("Sequence diagrams"), which would trip strict mode.
        const cardTitle = (t: string) =>
            page.locator('.ca-card-title', { hasText: new RegExp(`^${t}$`) });
        await expect(cardTitle('System Design')).toBeVisible();
        await expect(cardTitle('API List')).toBeVisible();
        await expect(cardTitle('Sequence')).toBeVisible();
        await expect(cardTitle('Flow Chart')).toBeVisible();
        await expect(cardTitle('Tour')).toBeVisible();
        await expect(cardTitle('API Testing')).toBeVisible();
        // Whole-codebase overviews now sit LAST in the Diagrams section.
        await expect(cardTitle('Knowledge Map')).toBeVisible();
        await expect(cardTitle('Domains')).toBeVisible();
        // Git / replay section.
        await expect(cardTitle('Timeline Replay')).toBeVisible();
        await expect(cardTitle('Replay Working Changes')).toBeVisible();
        await expect(cardTitle('Replay PR')).toBeVisible();
        await expect(cardTitle('Replay Branch')).toBeVisible();
        // Tools section.
        await expect(cardTitle('Health Report')).toBeVisible();
        await expect(cardTitle('Impact Analysis')).toBeVisible();
        await expect(cardTitle('Search')).toBeVisible();
    });

    test('no uncaught JS errors on home page', async ({ page, serverUrl }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        // Wait a bit for any async errors
        await page.waitForTimeout(1000);
        expect(errors).toHaveLength(0);
    });

    test('screenshot: home page dark mode', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: 'e2e/screenshots/home-dark.png', fullPage: true });
    });

    test('AI Configuration section shows LLM status', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('.ca-home', { timeout: 10000 });
        // Section heading
        const sections = page.locator('.ca-section-label');
        const texts = await sections.allTextContents();
        expect(texts.map(t => t.toLowerCase())).toContain('ai configuration');
        // Status card shows provider and model
        const status = page.locator('[data-testid="llm-status"]');
        await expect(status).toBeVisible();
        await expect(status).toContainText('OpenRouter');
        await expect(status).toContainText('openrouter/free');
    });

    test('AI Configuration form opens and submits', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('[data-testid="llm-status"]', { timeout: 10000 });

        // Issue 351: cold-start flake — the form re-renders when the provider
        // changes (the endpoint field becomes visible) and the subsequent
        // `getByLabel('Model name').fill(...)` could race against React's
        // re-mount. Scope every interaction to the form container and
        // explicitly click each input to establish focus before typing.
        await page.getByLabel('Edit LLM configuration').click();
        const form = page.locator('[data-testid="llm-config-form"]');
        await expect(form).toBeVisible();

        // Wait for the form to actually be interactive (provider select editable).
        await expect(form.getByLabel('LLM provider')).toBeEditable();
        await form.getByLabel('LLM provider').selectOption('ollama');

        // Endpoint field becomes visible after provider change — wait for it
        // to be both attached AND visible so the React tree has settled before
        // the next interaction.
        await expect(form.getByLabel('LLM endpoint URL')).toBeVisible();
        await expect(form.getByLabel('LLM endpoint URL')).toBeEditable();

        // Model input — explicit click to establish focus before fill, then
        // expect the input to actually hold the typed value before clicking Save.
        const modelInput = form.getByLabel('Model name');
        await expect(modelInput).toBeEditable();
        await modelInput.click();
        await modelInput.fill('llama3');
        await expect(modelInput).toHaveValue('llama3');

        await form.getByLabel('Save LLM configuration').click();
        await expect(form).not.toBeVisible();

        const status = page.locator('[data-testid="llm-status"]');
        await expect(status).toContainText('Ollama');
        await expect(status).toContainText('llama3');
    });

    test('AI Configuration card is left-aligned with other right-column sections', async ({ page, serverUrl }) => {
        await page.goto(`${serverUrl}#/home`);
        await page.waitForSelector('[data-testid="llm-status"]', { timeout: 10000 });
        // Issue 543 — the home grid is two columns (diagrams/git/tools on the
        // left, AI surfaces on the right). The AI Configuration card lives in
        // the right column with the Code Review controls, so we assert it's
        // left-aligned with its sibling AiReviewControlCard, not with the
        // left-column dashboard cards.
        const aiCardBox = await page.locator('[data-testid="ai-review-control-card"]').boundingBox();
        const llmBox = await page.locator('[data-testid="llm-status"]').boundingBox();
        expect(aiCardBox).not.toBeNull();
        expect(llmBox).not.toBeNull();
        // Left edges should be within 2px of each other inside the right column.
        expect(Math.abs(aiCardBox!.x - llmBox!.x)).toBeLessThanOrEqual(2);
    });
});
