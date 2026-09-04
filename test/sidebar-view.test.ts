import { Script } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerConfig } from '../src/containerConfig';
import { ContainerSyncResult, SyncedContainer } from '../src/containerSync';
import { PublicUserContainerApi } from '../src/api/publicApi';
import { UserRestApi } from '../src/api/restClient';
import { SidebarSyncState, SidebarViewProvider } from '../src/sidebarView';
import { WEBVIEW_SCRIPT } from '../src/webviewScript';
import * as vscode from './mocks/vscode';

describe('SidebarSyncState', () => {
    it('publishes the latest sync result and stops after disposal', () => {
        const state = new SidebarSyncState();
        const listener = vi.fn();
        const subscription = state.subscribe(listener);
        const result = { containers: [], changed: true };

        state.update(result);
        expect(listener).toHaveBeenCalledWith(result);
        expect(state.getState()).toEqual(result);

        subscription.dispose();
        state.update({ containers: [], changed: false });
        expect(listener).toHaveBeenCalledOnce();

        state.dispose();
        state.update(result);
        expect(state.getState()).toEqual({ containers: [], changed: false });
    });
});

describe('SidebarViewProvider', () => {
    beforeEach(() => {
        vscode.window.showErrorMessage.mockReset();
        vscode.window.showInformationMessage.mockReset();
        vscode.window.withProgress.mockReset();
        vscode.window.withProgress.mockImplementation((_options, task) => task({ report: vi.fn() }, {} as never) as Promise<unknown>);
    });

    it('renders status colors, actions, and a safe webview policy', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('running-1', 'running', true),
                syncedContainer('stopped-1', 'stopped', true),
                syncedContainer('pending-1', 'pending', true),
                syncedContainer('error-1', 'unknown', true, undefined, {
                    code: 'status_failed',
                    message: 'TestAgent Cloud 服务状态查询失败',
                }),
                syncedContainer('missing-1', 'missing', false, '2026-09-01T00:00:00.000Z'),
            ],
            changed: false,
        });
        const userApi = createUserApi(false);
        const view = createWebviewView();
        const provider = createProvider({ state, userApi });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.options).toMatchObject({
            enableScripts: true,
            enableForms: false,
            localResourceRoots: [],
        });
        expect(view.webview.html).toContain('status-dot running');
        expect(view.webview.html).toContain('status-dot stopped');
        expect(view.webview.html).toContain('status-dot unknown');
        expect(view.webview.html).toContain('status-dot error');
        expect(view.webview.html).toContain('status-dot missing');
        expect(view.webview.html).toContain('<span class="status-label">准备中</span>');
        expect(view.webview.html).toContain('.status-dot.stopped, .status-dot.error');
        expect(view.webview.html).toContain('data-action="connect"');
        expect(view.webview.html).toContain('post(\'connect\'');
        expect(view.webview.html).not.toContain('data-action="openConfig"');
        expect(view.webview.html).toContain('data-action="refresh"');
        expect(view.webview.html).toContain('<h1 class="page-title">TestAgent Cloud 服务管理面板</h1>');
        expect(view.webview.html).not.toContain('REMOTE WORKSPACE');
        expect(view.webview.html).not.toContain('YOUR SERVICES');
        expect(view.webview.html).not.toContain('>TC<');
        expect(view.webview.html).toContain('<section class="container-list">');
        expect(view.webview.html).toContain('此服务已过期并被资源回收');
        expect(view.webview.html).not.toContain('data-action="create"');
        expect(view.webview.html).not.toContain('10.0.0.1:22');
        expect(view.webview.html).toContain('service-status');
        expect(view.webview.html).not.toContain('service-glyph');
        expect(view.webview.html).not.toContain('service-title-row');
        expect(view.webview.html).toContain('border-radius: 10px');
        expect(view.webview.html).toContain('border-radius: 12px');
        expect(view.webview.html).toContain('.action-button { position: relative;');
        expect(view.webview.html).toContain('button.is-loading');
        expect(view.webview.html).toContain('justify-content: center');
        expect(view.webview.html).toContain('.app-bar { display: flex; align-items: center;');
        expect(view.webview.html).toContain('.sidebar { width: 100%; max-width: none; margin: 0; }');
        expect(view.webview.html).toContain('.icon-button { width: 32px; height: 32px; min-height: 32px;');
        expect(view.webview.html).toContain('border: 1px solid var(--outline)');
        expect(view.webview.html).toContain('font-family: var(--vscode-font-family,');
        expect(view.webview.html).not.toContain('--vscode-editorWidget-background');
        expect(view.webview.html).not.toContain('color-mix(');
        expect(view.webview.html).not.toContain('filter: brightness(');
        expect(view.webview.html).toContain('global acquireVsCodeApi, document');
        expect(view.webview.html).not.toContain('MouseEvent');
        expect(view.webview.html).not.toContain('instanceof Element');
        expect(view.webview.html).not.toContain('.closest(');
        expect(view.webview.html).not.toContain('.dataset');
        expect(view.webview.html).toContain('script-src \'nonce-');
        expect(view.webview.html).not.toContain('data-action="openAdmin"');
        expect(userApi.checkAdmin).toHaveBeenCalledWith({ user_id: 'user-1' });
    });

    it('renders only the cloud card in cloud mode', async () => {
        const view = createWebviewView();
        const userApiFactory = vi.fn(() => createUserApi(false));
        const provider = createProvider({
            cloudMode: true,
            view,
            userApiFactory,
        });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('当前已连接至 TestAgent Cloud 服务中');
        expect(view.webview.html).toContain('.cloud-card { min-height: 270px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 30px 20px; border: 2px solid var(--warning);');
        expect(view.webview.html).toContain('.cloud-card p { margin: 0 0 8px; color: var(--warning);');
        expect(view.webview.html).toContain('.cloud-card .action-button { width: 100%; max-width: 160px; min-height: 28px; padding: 0 12px; }');
        expect(view.webview.html).toContain('data-action="disconnect"');
        expect(view.webview.html).not.toContain('data-action="refresh"');
        expect(view.webview.html).not.toContain('data-action="openConfig"');
        expect(userApiFactory).not.toHaveBeenCalled();
    });

    it('rechecks cloud mode when the sidebar becomes visible again', async () => {
        let cloudMode = false;
        const view = createWebviewView();
        const getCloudMode = vi.fn(() => cloudMode);
        const provider = createProvider({ view, getCloudMode });

        await provider.resolveWebviewView(view as never);
        expect(view.webview.html).not.toContain('当前已连接至 TestAgent Cloud 服务中');

        cloudMode = true;
        view.fireVisibility(true);
        await flushMessages();

        expect(getCloudMode).toHaveBeenCalledTimes(2);
        expect(view.webview.html).toContain('当前已连接至 TestAgent Cloud 服务中');
        expect(view.webview.html).not.toContain('data-action="refresh"');
    });

    it('refreshes cloud mode on demand after opening a remote connection', async () => {
        let cloudMode = false;
        const view = createWebviewView();
        const getCloudMode = vi.fn(() => cloudMode);
        const provider = createProvider({ view, getCloudMode });

        await provider.resolveWebviewView(view as never);
        cloudMode = true;
        await provider.refreshCloudMode();

        expect(getCloudMode).toHaveBeenCalledTimes(2);
        expect(view.webview.html).toContain('当前已连接至 TestAgent Cloud 服务中');
    });

    it('renders a centered error without normal controls when configuration is invalid', async () => {
        const view = createWebviewView();
        const userIdProvider = { getCurrentUserId: vi.fn(async () => 'user-1') };
        const provider = createProvider({
            view,
            userIdProvider,
            getSettings: () => settings(''),
        });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('未配置后端 TestAgent Cloud 管理服务的 API 地址');
        expect(view.webview.html).toContain('error-page');
        const errorStyle = view.webview.html.match(/\.error-page \{[^}]+\}/)?.[0] ?? '';
        expect(errorStyle).toContain('min-height: calc(100vh - 40px)');
        expect(errorStyle).toContain('align-items: center');
        expect(errorStyle).toContain('justify-content: center');
        expect(errorStyle).not.toContain('border-radius');
        expect(errorStyle).not.toContain('background');
        expect(errorStyle).not.toContain('box-shadow');
        expect(view.webview.html).not.toContain('.cloud-card, .error-page {');
        expect(view.webview.html).not.toContain('data-action="refresh"');
        expect(userIdProvider.getCurrentUserId).not.toHaveBeenCalled();
    });

    it('does not replace the webview when a scheduled refresh has no visible changes', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);
        await flushMessages();
        const initialHtml = view.webview.html;

        state.update({ containers: [], changed: false });

        expect(view.webview.html).toBe(initialHtml);
    });

    it('routes only whitelisted messages and refreshes after user actions', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('container-1', 'running', true)],
            changed: false,
        });
        const userApi = createUserApi(false);
        const publicApi = createPublicApi();
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const onConnect = vi.fn();
        const provider = createProvider({ state, userApi, publicApi, sync, onConnect });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'connect', containerId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'restart', containerId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'delete', containerId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'executeCommand', commandId: 'workbench.action.remote.close' });
        await flushMessages();

        expect(onConnect).toHaveBeenCalledWith('host-container-1');
        expect(publicApi.restartContainer).toHaveBeenCalledWith('container-1');
        expect(publicApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(sync.refresh).toHaveBeenCalledTimes(2);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.remote.close');
    });

    it('removes the local config entry after deleting a remote service', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('container-1', 'running', true)],
            changed: false,
        });
        const config = createConfig();
        const publicApi = createPublicApi();
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const provider = createProvider({ state, config, publicApi, sync });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'delete', containerId: 'container-1' });
        await flushMessages();

        expect(publicApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(config.removeContainer).toHaveBeenCalledWith(expect.anything(), 'container-1');
        expect(config.write).toHaveBeenCalledOnce();
        expect(sync.refresh).toHaveBeenCalledOnce();
    });

    it('shows the administrator entry only after /user/check grants access', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const userApi = createUserApi(true);
        const onOpenAdmin = vi.fn();
        const view = createWebviewView();
        const provider = createProvider({ state, userApi, onOpenAdmin, view });

        await provider.resolveWebviewView(view as never);
        await flushMessages();

        expect(view.webview.html).toContain('data-action="openAdmin"');
        expect(view.webview.html.indexOf('data-action="openAdmin"')).toBeLessThan(view.webview.html.indexOf('data-action="openConfig"'));
        expect(view.webview.html.indexOf('data-action="openConfig"')).toBeLessThan(view.webview.html.indexOf('data-action="refresh"'));
        view.fireMessage({ command: 'openAdmin' });
        await flushMessages();
        expect(onOpenAdmin).toHaveBeenCalledOnce();
    });

    it('removes a history entry locally without calling a remote delete API', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('history-1', 'missing', false, '2026-09-01T00:00:00.000Z')],
            changed: false,
        });
        const config = createConfig();
        const publicApi = createPublicApi();
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const provider = createProvider({ state, config, publicApi, sync });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'removeHistory', containerId: 'history-1' });
        await flushMessages();

        expect(config.removeContainer).toHaveBeenCalledWith(expect.anything(), 'history-1');
        expect(config.write).toHaveBeenCalledOnce();
        expect(publicApi.deleteContainer).not.toHaveBeenCalled();
    });

    it('shows the deletion banner only for a service missing from the cloud', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('active-with-expiration', 'running', true, '2026-09-02T00:00:00.000Z'),
                syncedContainer('deleted-in-cloud', 'missing', false, '2026-09-02T00:00:00.000Z'),
            ],
            changed: false,
        });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html.match(/<div class="history-warning"/g)).toHaveLength(1);
        expect(view.webview.html).toContain('data-container-id="deleted-in-cloud"');
    });

    it('creates a user container, validates its endpoint, and writes only user fields', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'created-1',
            status: 'pending',
            endpoint: '10.0.0.5:2222',
        }));
        const values = ['alice', 'repo', 'main', 'https://gitee.com'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => ['授权使用 TestAgent 码云通用账户']);
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const provider = createProvider({ state, config, publicApi, sync, showInputBox, showQuickPick });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(publicApi.createContainer).toHaveBeenCalledWith({
            gitee_url: 'https://gitee.com',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            authorize_general_account: true,
        });
        expect(showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: '完整码云仓库地址或者码云用户名' }));
        expect(showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: '码云仓库名' }));
        expect(showInputBox).toHaveBeenNthCalledWith(3, expect.objectContaining({ prompt: '码云分支 (可选)' }));
        expect(showInputBox).toHaveBeenNthCalledWith(4, expect.objectContaining({ prompt: '码云地址前缀' }));
        expect(showQuickPick).toHaveBeenCalledWith(['授权使用 TestAgent 码云通用账户'], expect.objectContaining({ canPickMany: true }));
        expect(config.upsertContainer).toHaveBeenCalledWith(expect.anything(), {
            containerId: 'created-1',
            host: 'alice/repo',
            hostName: '10.0.0.5',
            port: 2222,
        }, { skipKnownHostsCheck: true, userName: 'root' });
        expect(config.write).toHaveBeenCalledOnce();
        expect(sync.refresh).toHaveBeenCalledOnce();
        expect(vscode.window.withProgress).toHaveBeenCalledWith(
            {
                title: '正在创建TestAgent Cloud 服务...',
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
            },
            expect.any(Function),
        );
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('TestAgent Cloud 服务创建成功');
    });

    it('extracts Gitee fields from a repository URL and only asks for the branch', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'created-from-url',
            status: 'pending',
            endpoint: '10.0.0.7:2222',
        }));
        const values = ['https://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh.git', 'develop'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => []);
        const provider = createProvider({ config, publicApi, showInputBox, showQuickPick });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledTimes(2);
        expect(publicApi.createContainer).toHaveBeenCalledWith({
            gitee_url: 'https://github.com',
            gitee_user: 'JustWorkingAndWorking',
            gitee_repository: 'testagent-cloud-remote-ssh',
            gitee_branch: 'develop',
            authorize_general_account: false,
        });
    });

    it('keeps the existing flow when the Gitee input is blank', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'created-without-gitee',
            status: 'pending',
            endpoint: '10.0.0.6:2222',
        }));
        const values = ['   '];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => []);
        const provider = createProvider({ config, publicApi, showInputBox, showQuickPick });

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledOnce();
        expect(showQuickPick).toHaveBeenCalledOnce();
        expect(publicApi.createContainer).toHaveBeenCalledWith({ authorize_general_account: false });
        expect(config.upsertContainer).toHaveBeenCalledWith(expect.anything(), {
            containerId: 'created-without-gitee',
            host: 'TestAgent Cloud 服务',
            hostName: '10.0.0.6',
            port: 2222,
        }, { skipKnownHostsCheck: true, userName: 'root' });
    });

    it('requires a repository when the Gitee username is provided', async () => {
        const publicApi = createPublicApi();
        const values = ['alice', '   '];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => []);
        const provider = createProvider({ publicApi, showInputBox, showQuickPick });

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledTimes(2);
        expect(showQuickPick).not.toHaveBeenCalled();
        expect(publicApi.createContainer).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('码云仓库名不能为空', { modal: true });
    });

    it('does not write configuration when the create response has an invalid endpoint', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'created-2',
            status: 'pending',
            endpoint: 'example.com:22',
        }));
        const values = ['alice', 'repo', 'main', 'https://gitee.com'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => []);
        const provider = createProvider({ config, publicApi, showInputBox, showQuickPick });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "created-2" 的 endpoint 无效，应为 IP:Port 格式：example.com:22',
            { modal: true },
        );
        expect(config.read).not.toHaveBeenCalled();
        expect(config.upsertContainer).not.toHaveBeenCalled();
        expect(config.write).not.toHaveBeenCalled();
    });

    it('does not show the manual create form while remotely connected', async () => {
        const showInputBox = vi.fn(async () => 'unused');
        const publicApi = createPublicApi();
        const provider = createProvider({
            publicApi,
            showInputBox,
            isDisconnected: () => false,
        });

        await provider.createContainerFromPrompt();

        expect(showInputBox).not.toHaveBeenCalled();
        expect(publicApi.createContainer).not.toHaveBeenCalled();
    });
});

describe('Webview script', () => {
    it('is valid JavaScript without host-side DOM type annotations', () => {
        expect(() => new Script(WEBVIEW_SCRIPT)).not.toThrow();
        expect(WEBVIEW_SCRIPT).not.toContain('MouseEvent');
        expect(WEBVIEW_SCRIPT).not.toContain('closest(');
        expect(WEBVIEW_SCRIPT).toContain('querySelectorAll');
        expect(WEBVIEW_SCRIPT).toContain('startLoading');
        expect(WEBVIEW_SCRIPT).toContain('operationComplete');
    });
});

function syncedContainer(
    containerId: string,
    status: string,
    remote: boolean,
    expiresAt?: string,
    error?: SyncedContainer['error'],
): SyncedContainer {
    return {
        containerId,
        host: `host-${containerId}`,
        hostName: '10.0.0.1',
        status,
        remote,
        ...(remote ? { endpoint: '10.0.0.1:22' } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(error ? { error } : {}),
    };
}

function createProvider(options: Partial<ProviderTestOptions> = {}): SidebarViewProvider {
    const state = options.state ?? new SidebarSyncState();
    const userApi = options.userApi ?? createUserApi(false);
    const settingsValue = options.getSettings ?? (() => settings('https://api.example.test'));
    return new SidebarViewProvider({
        state,
        sync: options.sync ?? { refresh: vi.fn(async () => ({ containers: [], changed: false })) },
        config: options.config ?? createConfig(),
        publicApi: options.publicApi ?? createPublicApi(),
        userIdProvider: options.userIdProvider ?? { getCurrentUserId: vi.fn(async () => 'user-1') },
        userApiFactory: options.userApiFactory ?? vi.fn(() => userApi),
        getSettings: settingsValue,
        cloudMode: options.cloudMode,
        getCloudMode: options.getCloudMode,
        isDisconnected: options.isDisconnected,
        onOpenConfig: options.onOpenConfig,
        onOpenAdmin: options.onOpenAdmin,
        onConnect: options.onConnect,
        onDisconnect: options.onDisconnect,
        showInputBox: options.showInputBox,
        showQuickPick: options.showQuickPick,
    });
}

interface ProviderTestOptions {
    state: SidebarSyncState;
    sync: { refresh: () => Promise<ContainerSyncResult> };
    config: ContainerConfig;
    publicApi: PublicUserContainerApi;
    userIdProvider: { getCurrentUserId: () => Promise<string> };
    userApi: UserRestApi;
    userApiFactory: (baseUrl: string) => UserRestApi;
    getSettings: () => ReturnType<typeof settings>;
    cloudMode: boolean;
    getCloudMode: () => boolean;
    isDisconnected: () => boolean;
    onOpenConfig: () => void | Promise<void>;
    onOpenAdmin: () => void | Promise<void>;
    onConnect: (host: string) => void | Promise<void>;
    onDisconnect: () => void | Promise<void>;
    showInputBox: (options: import('vscode').InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick: (
        items: readonly string[],
        options: import('vscode').QuickPickOptions & { canPickMany: true },
    ) => Thenable<string[] | undefined>;
    view: ReturnType<typeof createWebviewView>;
}

function createUserApi(admin: boolean): UserRestApi {
    return {
        createContainer: vi.fn(async () => ({ container_id: 'container-1', status: 'pending' })),
        getContainerIds: vi.fn(async () => ({ container_ids: [] })),
        getContainer: vi.fn(async () => ({
            container_id: 'container-1',
            status: 'running',
            gitee_user: '',
            gitee_repository: '',
        })),
        checkAdmin: vi.fn(async () => ({ admin })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
}

function createPublicApi(): PublicUserContainerApi {
    return {
        createContainer: vi.fn(async () => ({ container_id: 'container-1', status: 'pending' })),
        getContainerIds: vi.fn(async () => ({ container_ids: [] })),
        getContainer: vi.fn(async () => ({
            container_id: 'container-1',
            status: 'running',
            gitee_user: '',
            gitee_repository: '',
        })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
}

function createConfig(): ContainerConfig {
    const document = { config: {}, originalText: '' };
    return {
        read: vi.fn(async () => document),
        list: vi.fn(() => []),
        removeContainer: vi.fn(() => true),
        upsertContainer: vi.fn(() => true),
        write: vi.fn(async () => true),
    } as unknown as ContainerConfig;
}

function settings(backendApiUrl: string) {
    return {
        backendApiUrl,
        userName: 'root',
        skipKnownHostsCheck: true,
        historyLimit: 5,
        statusSyncInterval: 5,
        debug: false,
        disableClientValidation: true,
    };
}

function createWebviewView() {
    const receiveMessage = createEvent<unknown>();
    const dispose = createEvent<void>();
    const visibility = createEvent<void>();
    let visible = true;
    const view = {
        get visible() {
            return visible;
        },
        webview: {
            options: {},
            html: '',
            onDidReceiveMessage: receiveMessage.event,
            postMessage: vi.fn(async () => true),
        },
        onDidDispose: dispose.event,
        onDidChangeVisibility: visibility.event,
        fireMessage: (message: unknown) => receiveMessage.fire(message),
        fireVisibility: (nextVisible: boolean) => {
            visible = nextVisible;
            visibility.fire(undefined);
        },
        dispose: () => dispose.fire(undefined),
    };
    return view;
}

function createEvent<T>() {
    let listener: ((value: T) => void) | undefined;
    return {
        event: (nextListener: (value: T) => void) => {
            listener = nextListener;
            return {
                dispose: () => {
                    if (listener === nextListener) {
                        listener = undefined;
                    }
                },
            };
        },
        fire: (value: T) => listener?.(value),
    };
}

async function flushMessages(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}
