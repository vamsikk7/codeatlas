import * as vscode from 'vscode';
import type { StoredSession } from '../auth/clerkAuthService';

export class AuthStatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private session: StoredSession | null;

    constructor(session: StoredSession | null) {
        this.session = session;
    }

    setUser(session: StoredSession | null): void {
        this.session = session;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        if (this.session) {
            const displayName = this.session.firstName
                ? `${this.session.firstName}${this.session.lastName ? ' ' + this.session.lastName : ''}`
                : this.session.email;

            const nameItem = new vscode.TreeItem(`${displayName} <${this.session.email}>`);
            nameItem.tooltip = `Signed in as ${this.session.email}`;
            nameItem.contextValue = 'authUser';

            const signOutItem = new vscode.TreeItem('Sign Out');
            signOutItem.command = { command: 'codeatlas.logout', title: 'Sign Out' };
            signOutItem.tooltip = 'Sign out of CodeAtlas';
            signOutItem.contextValue = 'authSignOut';

            return [nameItem, signOutItem];
        }

        const signInItem = new vscode.TreeItem('Sign In to CodeAtlas');
        signInItem.command = { command: 'codeatlas.login', title: 'Sign In' };
        signInItem.tooltip = 'Sign in to access CodeAtlas diagrams';
        signInItem.contextValue = 'authSignIn';

        return [signInItem];
    }
}
