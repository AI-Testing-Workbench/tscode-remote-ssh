import * as vscode from 'vscode';
import {Log} from './common/logger';
import {REMOTE_SSH_AUTHORITY, RemoteSSHResolver} from './authResolver';
import {connectToContainer, openSSHConfigFile, promptOpenRemoteSSHWindow} from './commands';
import {getRemoteWorkspaceLocationData, RemoteLocationHistory} from './remoteLocationHistory';
import {handleOpenRecentUri} from './openRecentUri';
import {type CloudModeOptions, initializeCloudMode, refreshCloudMode} from './cloudMode';
import {RestClient} from './api/restClient';
import {ContainerConfig} from './containerConfig';
import {ContainerSync} from './containerSync';
import {SidebarSyncState, SidebarViewProvider} from './sidebarView';
import {UserIdProvider} from './user';
import {createPublicUserContainerApi, type TestAgentRemoteApi} from './api/publicApi';
import SSHDestination from './ssh/sshDestination';
import {AdminPanel} from './adminPanel';
import {ContainerOperationRegistry} from './containerOperations';
import {ContainerInitializationPoller} from './containerInitializationPoller';
import {getRemoteSettings} from './settings';

let activeContainerSync: ContainerSync | undefined;
let activeSidebarView: SidebarViewProvider | undefined;
let activeSidebarSyncState: SidebarSyncState | undefined;
let activeAdminPanel: AdminPanel | undefined;
let activeInitializationController: AbortController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<TestAgentRemoteApi> {
    const logger = new Log('TSCode Remote');
    context.subscriptions.push(logger);
    const cloudModeOptions: CloudModeOptions = {
        onFileCheckError: error => logger.error('检查云端模式标记文件失败，按非云端模式处理', error),
    };
    initializeCloudMode(cloudModeOptions);

    const sidebarSyncState = new SidebarSyncState();
    const userIdProvider = new UserIdProvider();
    const config = new ContainerConfig();
    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    const initializationSettings = getRemoteSettings();
    const initializationController = new AbortController();
    activeInitializationController = initializationController;
    const initializationPoller = new ContainerInitializationPoller({
        gitApi: new RestClient(initializationSettings.backendApiUrl).git,
        statusSyncInterval: initializationSettings.statusSyncInterval,
    });
    const publicApi = createPublicUserContainerApi({
        userIdProvider,
        initializationPoller,
        initializationSignal: initializationController.signal,
        containerConfig: config,
        sftpProvider: async entry => ({
            sftp: await remoteSSHResolver.getSftp(entry.host),
        }),
    });
    const operationRegistry = new ContainerOperationRegistry();
    const getCloudMode = async (): Promise<boolean> => {
        const localCloudMode = refreshCloudMode(cloudModeOptions);
        if (localCloudMode) {
            return true;
        }

        const remoteHost = getCurrentRemoteHost();
        if (!remoteHost) {
            return false;
        }

        try {
            const document = await config.read();
            return config.list(document.config).some(entry =>
                !entry.expiresAt && entry.host.toLowerCase() === remoteHost.toLowerCase());
        } catch (error) {
            logger.error('读取当前远程服务配置失败，按非云端模式处理', error);
            return false;
        }
    };
    const cloudMode = await getCloudMode();
    const userApiFactory = (baseUrl: string) => new RestClient(baseUrl).user;
    const containerSync = new ContainerSync({
        config,
        userIdProvider,
        userApiFactory,
        operationRegistry,
        onSync: result => sidebarSyncState.update(result),
        onInvalidEndpoint: ({ containerId, endpoint }) => {
            void vscode.window.showErrorMessage(
                `云端沙箱 服务 "${containerId}" 的 endpoint 无效，应为 IP:Port：${endpoint ?? '(空)'}`,
                { modal: true },
            );
        },
    });
    const adminPanel = new AdminPanel({
        userIdProvider,
        containerConfig: config,
        onConnect: (host, giteeRepository) => connectToContainer(
            host,
            () => activeSidebarView?.refreshCloudMode(),
            giteeRepository,
        ),
        operationRegistry,
        initializationPoller,
        initializationSignal: initializationController.signal,
        logger,
        onContainerOperation: operation => containerSync.reconcileContainerOperation(operation),
    });
    activeContainerSync = containerSync;
    const sidebarView = new SidebarViewProvider({
        state: sidebarSyncState,
        sync: containerSync,
        config,
        publicApi,
        userIdProvider,
        operationRegistry,
        cloudMode,
        getCloudMode,
        onOpenConfig: async () => {
            await openSSHConfigFile();
        },
        onOpenAdmin: () => adminPanel.open(),
        onConnect: (host, giteeRepository) => connectToContainer(
            host,
            () => activeSidebarView?.refreshCloudMode(),
            giteeRepository,
        ),
        onDisconnect: async () => {
            await vscode.commands.executeCommand('workbench.action.remote.close');
        },
    });
    activeSidebarView = sidebarView;
    activeSidebarSyncState = sidebarSyncState;
    activeAdminPanel = adminPanel;
    context.subscriptions.push(
        operationRegistry,
        containerSync,
        sidebarSyncState,
        sidebarView,
        adminPanel,
        vscode.window.registerWebviewViewProvider('sshHosts', sidebarView, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );
    if (!cloudMode) {
        containerSync.start();
    }

    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);
    context.subscriptions.push({ dispose: () => initializationController.abort() });

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri: uri => handleOpenRecentUri(uri, locationHistory, logger),
    }));

    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', async () => {
        try {
            await sidebarView.openConfigFile();
        } catch (error) {
            logger.error('打开 SSH 配置文件失败', error);
            void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : '无法打开 SSH 配置文件',
                { modal: true },
            );
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.refreshContainers', () => containerSync.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.createContainer', () => sidebarView.createContainerFromPrompt()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openAdmin', () => adminPanel.open()));

    return publicApi;
}

function getCurrentRemoteHost(): string | undefined {
    const remoteAuthority = vscode.env.remoteAuthority;
    const prefix = `${REMOTE_SSH_AUTHORITY}+`;
    if (!remoteAuthority?.startsWith(prefix)) {
        return undefined;
    }
    return SSHDestination.parseEncoded(remoteAuthority.slice(prefix.length)).hostname;
}

export function deactivate() {
    activeInitializationController?.abort();
    activeInitializationController = undefined;
    activeSidebarView?.dispose();
    activeSidebarView = undefined;
    activeSidebarSyncState?.dispose();
    activeSidebarSyncState = undefined;
    activeContainerSync?.dispose();
    activeContainerSync = undefined;
    activeAdminPanel?.dispose();
    activeAdminPanel = undefined;
}
