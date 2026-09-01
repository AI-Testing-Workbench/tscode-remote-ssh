import * as vscode from 'vscode';
import { Log } from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import { openSSHConfigFile, promptOpenRemoteSSHWindow } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';
import { initializeCloudMode } from './cloudMode';
import { RestClient } from './api/restClient';
import { ContainerConfig } from './containerConfig';
import { ContainerSync } from './containerSync';
import { SidebarSyncState } from './sidebarView';
import { UserIdProvider } from './user';

let activeContainerSync: ContainerSync | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('TestAgent - Remote');
    context.subscriptions.push(logger);
    initializeCloudMode({
        onFileCheckError: error => logger.error('检查云端模式标记文件失败，按非云端模式处理', error),
    });

    const sidebarSyncState = new SidebarSyncState();
    const containerSync = new ContainerSync({
        config: new ContainerConfig(),
        userIdProvider: new UserIdProvider(),
        userApiFactory: baseUrl => new RestClient(baseUrl).user,
        onSync: result => sidebarSyncState.update(result),
        onInvalidEndpoint: ({ containerId, endpoint }) => {
            void vscode.window.showErrorMessage(
                `容器 "${containerId}" 的 endpoint 无效，应为 IP:端口格式：${endpoint ?? '(空)'}`,
                { modal: true },
            );
        },
    });
    activeContainerSync = containerSync;
    context.subscriptions.push(containerSync, sidebarSyncState);
    containerSync.start();

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(vscode.window.createTreeView('sshHosts', { treeDataProvider: hostTreeDataProvider }));
    context.subscriptions.push(hostTreeDataProvider);

    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.refreshContainers', () => containerSync.refresh()));
}

export function deactivate() {
    activeContainerSync?.dispose();
    activeContainerSync = undefined;
}
