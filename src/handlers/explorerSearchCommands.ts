/**
 * explorerSearchCommands.ts — Issue #358 Row 7e (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * four "filter the explorer sidebar" commands, all of which follow the
 * exact same shape: show an input box pre-filled with the current
 * filter; if the user confirms (even with an empty string), push the
 * new filter into the matching tree-data provider. A blank string clears
 * the filter; pressing Esc cancels and leaves the existing filter intact.
 *
 *   - codeatlas.searchApiExplorer
 *   - codeatlas.searchFunctionExplorer
 *   - codeatlas.searchFileExplorer
 *   - codeatlas.searchFeatureExplorer
 *
 * DRY'd via the shared `makeSearchCommand` factory so adding a fifth
 * explorer in the future is a single new entry in the list, not another
 * copy of the input-box-and-set-filter dance.
 */

import * as vscode from 'vscode';

/** Minimum surface a filterable explorer tree-data provider must expose. */
export interface FilterableExplorerProvider {
    getFilter(): string;
    setFilter(query: string): void;
}

export interface ExplorerSearchCommandDeps {
    apiExplorerProvider: FilterableExplorerProvider;
    functionExplorerProvider: FilterableExplorerProvider;
    fileExplorerProvider: FilterableExplorerProvider;
    featureExplorerProvider: FilterableExplorerProvider;
}

function makeSearchCommand(
    command: string,
    provider: FilterableExplorerProvider,
    prompt: string,
    placeHolder: string,
): vscode.Disposable {
    return vscode.commands.registerCommand(command, async () => {
        const current = provider.getFilter();
        const query = await vscode.window.showInputBox({ prompt, placeHolder, value: current });
        if (query === undefined) return;
        provider.setFilter(query);
    });
}

export function registerExplorerSearchCommands(deps: ExplorerSearchCommandDeps): vscode.Disposable[] {
    return [
        makeSearchCommand(
            'codeatlas.searchApiExplorer',
            deps.apiExplorerProvider,
            'Filter APIs by method, route, or handler name',
            'e.g. POST, /todos, createTodo',
        ),
        makeSearchCommand(
            'codeatlas.searchFunctionExplorer',
            deps.functionExplorerProvider,
            'Filter functions by name or file path',
            'e.g. createOrder, routes.ts',
        ),
        makeSearchCommand(
            'codeatlas.searchFileExplorer',
            deps.fileExplorerProvider,
            'Filter files by path or name',
            'e.g. controller, src/routes',
        ),
        makeSearchCommand(
            'codeatlas.searchFeatureExplorer',
            deps.featureExplorerProvider,
            'Filter feature clusters by name or file',
            'e.g. Order, payment',
        ),
    ];
}
