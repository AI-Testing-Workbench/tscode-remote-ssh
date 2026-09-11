import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface GitIdentity {
    username: string;
    email: string;
}

export type GitConfigCommandRunner = (args: readonly string[], cwd?: string) => Promise<string>;

export interface GitConfigReaderOptions {
    runGit?: GitConfigCommandRunner;
    getWorkspaceFolders?: () => readonly string[];
    getActiveEditorPath?: () => string | undefined;
}

export class GitConfigReader {
    private readonly runGit: GitConfigCommandRunner;
    private readonly getWorkspaceFolders: () => readonly string[];
    private readonly getActiveEditorPath: () => string | undefined;

    public constructor(options: GitConfigReaderOptions = {}) {
        this.runGit = options.runGit ?? runGitConfigCommand;
        this.getWorkspaceFolders = options.getWorkspaceFolders ?? (() =>
            vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []);
        this.getActiveEditorPath = options.getActiveEditorPath ?? (() => vscode.window.activeTextEditor?.document.uri.fsPath);
    }

    public async read(): Promise<GitIdentity> {
        const workspace = this.getPreferredWorkspace();
        const localUsername = workspace ? await this.readValue(workspace, 'user.name', true) : undefined;
        const localEmail = workspace ? await this.readValue(workspace, 'user.email', true) : undefined;
        const username = localUsername ?? await this.readValue(undefined, 'user.name', false) ?? '';
        const email = localEmail ?? await this.readValue(undefined, 'user.email', false) ?? '';

        return { username, email };
    }

    private getPreferredWorkspace(): string | undefined {
        const folders = this.getWorkspaceFolders();
        if (!folders.length) {
            return undefined;
        }

        const activeEditorPath = this.getActiveEditorPath();
        if (activeEditorPath) {
            const activeWorkspace = folders.find(folder => isPathInside(folder, activeEditorPath));
            if (activeWorkspace) {
                return activeWorkspace;
            }
        }
        return folders[0];
    }

    private async readValue(cwd: string | undefined, key: string, local: boolean): Promise<string | undefined> {
        try {
            const scope = local ? '--local' : '--global';
            const output = await this.runGit(['config', scope, '--get', key], cwd);
            return output.trim();
        } catch {
            // Git is optional and a workspace does not have to be a repository.
            return undefined;
        }
    }
}

function runGitConfigCommand(args: readonly string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', [...args], {
            cwd,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function isPathInside(root: string, target: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
