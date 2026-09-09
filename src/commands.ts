import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';
import { ContainerConfig } from './containerConfig';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await promptForHost();

    if (!host) {
        return;
    }

    const sshDest = new SSHDestination(host);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

const OPEN_IN_CURRENT_WINDOW = '当前窗口打开';
const OPEN_IN_NEW_WINDOW = '新建窗口打开';

export async function connectToContainer(
    host: string,
    refreshSidebar?: () => void | Promise<void>,
): Promise<void> {
    let reuseWindow = !hasOpenWorkspace();
    if (!reuseWindow) {
        const choice = await vscode.window.showInformationMessage(
            '当前窗口已打开工作区，请选择连接 云端沙箱 服务的方式',
            OPEN_IN_CURRENT_WINDOW,
            OPEN_IN_NEW_WINDOW,
        );
        if (!choice) {
            return;
        }
        reuseWindow = choice === OPEN_IN_CURRENT_WINDOW;
    }

    const sshDest = new SSHDestination(host);
    await openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
    if (reuseWindow) {
        await refreshSidebar?.();
    }
}

/**
 * Lists only 云端沙箱 services from the dedicated config while still
 * accepting an arbitrary [user@]hostname[:port]. Whatever is typed is offered
 * as the first item, so typing a host and pressing enter keeps working.
 */
async function promptForHost(): Promise<string | undefined> {
    let configuredHosts: string[] = [];
    try {
        const config = new ContainerConfig();
        const document = await config.read();
        configuredHosts = [...new Set(config.list(document.config)
            .filter(entry => !entry.expiresAt)
            .map(entry => entry.host.trim())
            .filter(Boolean))];
    } catch {
        // Ignore and fall back to the plain input box below.
    }

    if (!configuredHosts.length) {
        return vscode.window.showInputBox({
            title: '请输入 [user@]hostname[:port]'
        });
    }

    const hostItems: vscode.QuickPickItem[] = configuredHosts.map(label => ({ label }));

    return new Promise<string | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = '连接到 云端沙箱 服务';
        quickPick.placeholder = '选择已配置的连接，或者输入 [user@]hostname[:port]';
        quickPick.items = hostItems;

        quickPick.onDidChangeValue(value => {
            const typed = value.trim();
            quickPick.items = typed && !configuredHosts.includes(typed)
                ? [{ label: typed, description: '连接到此 云端沙箱 服务' }, ...hostItems]
                : hostItems;
        });

        quickPick.onDidAccept(() => {
            const picked = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
            resolve(picked || undefined);
            quickPick.hide();
        });

        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });

        quickPick.show();
    });
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean): Thenable<unknown> {
    const defaultPath = vscode.workspace.getConfiguration('tscode.remote').get<string>('defaultPath', '');
    if (defaultPath) {
        return openRemoteSSHLocationWindow(host, defaultPath, reuseWindow);
    }

    return vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function addNewHost() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath), { preview: false });

    const textEditor = vscode.window.activeTextEditor;
    if (textEditor?.document.uri.fsPath !== sshConfigPath) {
        return;
    }

    const textDocument = textEditor.document;
    const lastLine = textDocument.lineAt(textDocument.lineCount - 1);

    if (!lastLine.isEmptyOrWhitespace) {
        await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.insert(lastLine.range.end, '\n');
        });
    }

    const snippet = '\nHost ${1:dev}\n\tHostName ${2:dev.example.com}\n\tUser ${3:john}';

    await textEditor.insertSnippet(
        new vscode.SnippetString(snippet),
        new vscode.Position(textDocument.lineCount, 0)
    );
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}

function hasOpenWorkspace(): boolean {
    return Boolean(vscode.workspace.workspaceFile) || (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}
