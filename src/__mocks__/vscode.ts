/**
 * Default vitest stub for the `vscode` module.
 *
 * Production code occasionally imports `vscode` for telemetry/lifecycle
 * helpers (analytics) that are not the unit-under-test. Tests that don't
 * intentionally mock vscode would otherwise fail with "Failed to load url
 * vscode". This file is wired in via vitest.config.ts -> resolve.alias so
 * any unmocked test gets a no-op shim. Tests that need richer behavior
 * still use `vi.mock('vscode', ...)` per-file as before.
 */
const noop = () => {};
const noopGetter = () => undefined;

export const window = {
    showInformationMessage: noop,
    showWarningMessage: noop,
    showErrorMessage: noop,
    createOutputChannel: () => ({ appendLine: noop, append: noop, dispose: noop, show: noop }),
    registerTreeDataProvider: noop,
    createWebviewPanel: () => ({ dispose: noop, webview: { postMessage: noop, html: '' } }),
    activeTextEditor: undefined,
    showTextDocument: noop,
    onDidChangeActiveTextEditor: () => ({ dispose: noop }),
    registerUriHandler: () => ({ dispose: noop }),
};
export const workspace = {
    getConfiguration: () => ({ get: noopGetter, update: noop }),
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => ({ dispose: noop }),
    onDidSaveTextDocument: () => ({ dispose: noop }),
    fs: {},
};
export const commands = {
    executeCommand: noop,
    registerCommand: () => ({ dispose: noop }),
};
export const env = {
    machineId: 'test-machine',
    sessionId: 'test-session',
    appName: 'Visual Studio Code',
    uriScheme: 'vscode',
    openExternal: noop,
};
export const version = '1.0.0';
export const Uri = {
    file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
    parse: (s: string) => ({ toString: () => s }),
};
export const Range = class {};
export const Position = class {};
export const ThemeIcon = class {};
export const TreeItem = class {};
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const EventEmitter = class<T> {
    event = (_listener: (e: T) => void) => ({ dispose: noop });
    fire = (_e: T) => {};
    dispose = noop;
};
export const ExtensionContext = class {};
export const extensions = { getExtension: () => undefined };

export default {
    window,
    workspace,
    commands,
    env,
    version,
    Uri,
    Range,
    Position,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
    EventEmitter,
    extensions,
};
