/**
 * exportFileCommands.ts — Issue #358 Row 7f (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * two file-based export commands. Distinct from
 * `src/handlers/exportHandlers.ts` (Row 5), which owns the API
 * collection export/import dispatched over the message router. These
 * are VS Code commands that write to an editor or to disk.
 *
 *   - codeatlas.exportDiagramsJson      → open all graphs as JSON in a
 *     new editor tab. Quick way to inspect the current snapshot without
 *     poking at SQLite.
 *   - codeatlas.exportArchitectureDocs  → write a Markdown architecture
 *     overview into `.codeatlas/architecture.md` and open it. Useful for
 *     PR descriptions, design docs, onboarding.
 *
 * Mechanical extraction — NO behavior change.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { analytics } from '../analytics/mixpanelService';
import { exportArchitectureDocs } from '../core/export/markdownExporter';
import type { SnapshotStore } from '../core/storage/snapshotStore';

export interface ExportFileCommandDeps {
    snapshotStore: SnapshotStore;
    workspaceRoot: string;
    notifyBrowser: (level: 'info' | 'warning' | 'error', message: string) => void;
}

export function registerExportFileCommands(deps: ExportFileCommandDeps): vscode.Disposable[] {
    const { snapshotStore, workspaceRoot, notifyBrowser } = deps;

    return [
        vscode.commands.registerCommand('codeatlas.exportDiagramsJson', async () => {
            analytics.track('diagrams_exported');
            const working = snapshotStore.getWorking();
            const content = JSON.stringify(working.graphs, null, 2);
            const doc = await vscode.workspace.openTextDocument({ content, language: 'json' });
            vscode.window.showTextDocument(doc);
        }),

        vscode.commands.registerCommand('codeatlas.exportArchitectureDocs', async () => {
            analytics.track('architecture_docs_exported');
            const working = snapshotStore.getWorking();
            const baseline = snapshotStore.getBaseline();
            const repoName = path.basename(workspaceRoot);
            const md = exportArchitectureDocs(working, baseline, repoName);

            // Write to .codeatlas/architecture.md, creating the parent
            // directory on first export so the user doesn't have to.
            const outputDir = path.join(workspaceRoot, '.codeatlas');
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const outputPath = path.join(outputDir, 'architecture.md');
            fs.writeFileSync(outputPath, md, 'utf-8');

            const doc = await vscode.workspace.openTextDocument(outputPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('CodeAtlas: Architecture docs exported to .codeatlas/architecture.md');
            notifyBrowser('info', 'Architecture docs exported to .codeatlas/architecture.md');
        }),
    ];
}
