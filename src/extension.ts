import * as vscode from 'vscode';
import { Log } from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import { openRemoteSSHWindow, openSSHConfigFile, promptOpenRemoteSSHWindow } from './commands';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';
import { initializeCloudMode } from './cloudMode';
import { RestClient } from './api/restClient';
import { ContainerConfig } from './containerConfig';
import { ContainerSync } from './containerSync';
import { SidebarSyncState, SidebarViewProvider } from './sidebarView';
import { UserIdProvider } from './user';
import { createPublicUserContainerApi, type TestAgentRemoteApi } from './api/publicApi';
import SSHDestination from './ssh/sshDestination';

let activeContainerSync: ContainerSync | undefined;
let activeSidebarView: SidebarViewProvider | undefined;
let activeSidebarSyncState: SidebarSyncState | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<TestAgentRemoteApi> {
    const logger = new Log('TestAgent - Remote');
    context.subscriptions.push(logger);
    const cloudMode = initializeCloudMode({
        onFileCheckError: error => logger.error('检查云端模式标记文件失败，按非云端模式处理', error),
    });

    const sidebarSyncState = new SidebarSyncState();
    const userIdProvider = new UserIdProvider();
    const publicApi = createPublicUserContainerApi({ userIdProvider });
    const config = new ContainerConfig();
    const userApiFactory = (baseUrl: string) => new RestClient(baseUrl).user;
    const containerSync = new ContainerSync({
        config,
        userIdProvider,
        userApiFactory,
        onSync: result => sidebarSyncState.update(result),
        onInvalidEndpoint: ({ containerId, endpoint }) => {
            void vscode.window.showErrorMessage(
                `TestAgent Cloud 服务 "${containerId}" 的 endpoint 无效，应为 IP:Port：${endpoint ?? '(空)'}`,
                { modal: true },
            );
        },
    });
    activeContainerSync = containerSync;
    const sidebarView = new SidebarViewProvider({
        state: sidebarSyncState,
        sync: containerSync,
        config,
        publicApi,
        userIdProvider,
        userApiFactory,
        cloudMode,
        onOpenConfig: async () => {
            await openSSHConfigFile();
        },
        onOpenAdmin: () => {
            void vscode.window.showInformationMessage('管理员页面将在后续版本开放。');
        },
        onConnect: host => openRemoteSSHWindow(new SSHDestination(host).toEncodedString(), false),
        onDisconnect: async () => {
            await vscode.commands.executeCommand('workbench.action.remote.close');
        },
    });
    activeSidebarView = sidebarView;
    activeSidebarSyncState = sidebarSyncState;
    context.subscriptions.push(
        containerSync,
        sidebarSyncState,
        sidebarView,
        vscode.window.registerWebviewViewProvider('sshHosts', sidebarView, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
    if (!cloudMode) {
        containerSync.start();
    }

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.refreshContainers', () => containerSync.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.createContainer', () => sidebarView.createContainerFromPrompt()));

    return publicApi;
}

export function deactivate() {
    activeSidebarView?.dispose();
    activeSidebarView = undefined;
    activeSidebarSyncState?.dispose();
    activeSidebarSyncState = undefined;
    activeContainerSync?.dispose();
    activeContainerSync = undefined;
}
