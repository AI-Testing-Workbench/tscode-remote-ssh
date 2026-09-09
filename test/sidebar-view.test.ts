import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerConfig } from '../src/containerConfig';
import { ContainerSyncResult, SyncedContainer } from '../src/containerSync';
import { ContainerOperationRegistry } from '../src/containerOperations';
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
        vscode.commands.executeCommand.mockReset();
        vscode.window.showErrorMessage.mockReset();
        vscode.window.showInformationMessage.mockReset();
        vscode.window.withProgress.mockReset();
        vscode.window.withProgress.mockImplementation((_options, task) => task({ report: vi.fn() }, {} as never) as Promise<unknown>);
        vscode.env.openExternal.mockReset();
        vscode.Uri.parse.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders status colors, actions, and a safe webview policy', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('running-1', 'running', true),
                syncedContainer('stopped-1', 'stopped', true),
                syncedContainer('failed-1', 'failed', true),
                syncedContainer('pending-1', 'pending', true),
                syncedContainer('error-1', 'unknown', true, undefined, {
                    code: 'status_failed',
                    message: '云端沙箱 服务状态查询失败',
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
        expect(view.webview.html).toContain('<span class="status-dot failed"></span>\n                    <span class="status-label">失败</span>');
        expect(view.webview.html).toContain('status-dot unknown');
        expect(view.webview.html).toContain('status-dot unknown error');
        expect(view.webview.html).toContain('status-dot missing');
        expect(view.webview.html).toContain('<span class="status-label">准备中</span>');
        expect(view.webview.html).toContain('.status-dot.stopped, .status-dot.failed, .status-dot.error');
        expect(view.webview.html).toContain('data-action="connect"');
        expect(view.webview.html).toContain('post(\'connect\'');
        expect(view.webview.html).toMatch(/<article class="container-card" data-container-id="running-1" data-connectable="true">/);
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="running-1" data-connectable="true">/);
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="stopped-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="failed-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="pending-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="restart" data-container-id="failed-1" disabled>/);
        expect(view.webview.html).toMatch(/data-action="restart" data-container-id="stopped-1">/);
        expect(view.webview.html).not.toContain('data-action="openConfig"');
        expect(view.webview.html).toContain('data-action="refresh"');
        expect(view.webview.html).not.toContain('<h1 class="page-title">');
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

    it('overlays an administrator lifecycle operation and hides a transient sync error', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('container-1', 'running', true)],
            changed: false,
            error: { code: 'request_timeout', message: '状态查询超时' },
        });
        const operationRegistry = new ContainerOperationRegistry();
        operationRegistry.begin('container-1', 'stop', 'admin');
        const view = createWebviewView();
        const provider = createProvider({ state, operationRegistry });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('status-dot pending');
        expect(view.webview.html).toContain('<span class="status-label">停止中</span>');
        expect(view.webview.html).not.toContain('状态查询超时');
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="container-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toContain('status-pulse');
    });

    it('renders usage separators, threshold colors, and remaining expiration time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'));
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('healthy-usage', 'running', true, '2026-09-05T02:03:45.000Z', undefined, {
                    cpuUsage: 74.9,
                    memoryUsage: null,
                }),
                syncedContainer('critical-usage', 'running', true, '2026-09-04T01:00:00.000Z', undefined, {
                    cpuUsage: 90,
                    memoryUsage: 75,
                }),
            ],
            changed: false,
        });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('&middot;</span>');
        expect(view.webview.html).toContain('usage-metric-low">CPU占用率 74.90%</span>');
        expect(view.webview.html).toContain('usage-metric-unavailable">内存使用率 --</span>');
        expect(view.webview.html).toContain('usage-metric-critical">CPU占用率 90.00%</span>');
        expect(view.webview.html).toContain('usage-metric-warning">内存使用率 75.00%</span>');
        expect(view.webview.html).toContain('expiration-status warning">服务剩余时间: 1天 2小时 3分钟</div>');
        expect(view.webview.html).toContain('expiration-status critical">服务剩余时间: 0天 1小时 0分钟</div>');
        expect(view.webview.html).toContain('.expiration-status { margin-top: 16px;');
        expect(view.webview.html.indexOf('expiration-status warning'))
            .toBeGreaterThan(view.webview.html.indexOf('class="card-actions"'));
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

        expect(view.webview.html).toContain('当前已连接至 云端沙箱 服务中');
        expect(view.webview.html).toContain('.cloud-card { min-height: 270px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 30px 20px; border: 2px solid var(--warning);');
        expect(view.webview.html).toContain('.cloud-card p { margin: 0 0 8px; color: var(--warning);');
        expect(view.webview.html).toContain('.cloud-card .action-button { width: 100%; max-width: 160px; max-height: 28px; padding: 0 12px; }');
        expect(view.webview.html).toContain('data-action="disconnect"');
        expect(view.webview.html).not.toContain('data-action="refresh"');
        expect(view.webview.html).not.toContain('data-action="openConfig"');
        expect(userApiFactory).not.toHaveBeenCalled();
    });

    it('dispatches cloud disconnect without touching container APIs or config', async () => {
        const view = createWebviewView();
        const onDisconnect = vi.fn();
        const publicApi = createPublicApi();
        const config = createConfig();
        const provider = createProvider({
            cloudMode: true,
            view,
            onDisconnect,
            publicApi,
            config,
        });

        await provider.resolveWebviewView(view as never);
        view.fireMessage({ command: 'disconnect' });
        await flushMessages();

        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(publicApi.deleteContainer).not.toHaveBeenCalled();
        expect(config.write).not.toHaveBeenCalled();
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('rechecks cloud mode when the sidebar becomes visible again', async () => {
        let cloudMode = false;
        const view = createWebviewView();
        const getCloudMode = vi.fn(() => cloudMode);
        const provider = createProvider({ view, getCloudMode });

        await provider.resolveWebviewView(view as never);
        expect(view.webview.html).not.toContain('当前已连接至 云端沙箱 服务中');

        cloudMode = true;
        view.fireVisibility(true);
        await flushMessages();

        expect(getCloudMode).toHaveBeenCalledTimes(2);
        expect(view.webview.html).toContain('当前已连接至 云端沙箱 服务中');
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
        expect(view.webview.html).toContain('当前已连接至 云端沙箱 服务中');
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

        expect(view.webview.html).toContain('未配置后端 云端沙箱 管理服务的 API 地址');
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

    it('allows connection only for running services', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('running-1', 'running', true),
                syncedContainer('stopped-1', 'stopped', true),
                syncedContainer('failed-1', 'failed', true),
                syncedContainer('pending-1', 'pending', true),
            ],
            changed: false,
        });
        const onConnect = vi.fn();
        const provider = createProvider({ state, onConnect });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        for (const containerId of ['running-1', 'stopped-1', 'failed-1', 'pending-1']) {
            view.fireMessage({ command: 'connect', containerId });
            await flushMessages();
        }

        expect(onConnect).toHaveBeenCalledOnce();
        expect(onConnect).toHaveBeenCalledWith('host-running-1');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(3);
    });

    it('does not restart a failed service', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('failed-1', 'failed', true)],
            changed: false,
        });
        const publicApi = createPublicApi();
        const provider = createProvider({ state, publicApi });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'restart', containerId: 'failed-1' });
        await flushMessages();

        expect(publicApi.restartContainer).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "failed-1" 处于失败状态，不能重启',
            { modal: true },
        );
    });

    it('blocks connection while a container restart is in progress', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('running-1', 'running', true)],
            changed: false,
        });
        const publicApi = createPublicApi();
        let releaseRestart: (() => void) | undefined;
        const restart = new Promise<void>(resolve => {
            releaseRestart = resolve;
        });
        publicApi.restartContainer = vi.fn(() => restart);
        const onConnect = vi.fn();
        const provider = createProvider({ state, publicApi, onConnect });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'restart', containerId: 'running-1' });
        await vi.waitFor(() => expect(publicApi.restartContainer).toHaveBeenCalledOnce());
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="running-1" data-connectable="false" disabled>/);

        view.fireMessage({ command: 'connect', containerId: 'running-1' });
        await flushMessages();

        expect(onConnect).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('正在执行操作'),
            { modal: true },
        );

        releaseRestart?.();
        await flushMessages();
        expect(view.webview.html).toMatch(/data-action="connect" data-container-id="running-1" data-connectable="true">/);
    });

    it('removes the local config entry after deleting a remote service', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('container-1', 'running', true)],
            changed: false,
        });
        const config = createConfig();
        const publicApi = createPublicApi();
        const staleResult = { containers: [syncedContainer('container-1', 'running', true)], changed: false };
        const sync = {
            refresh: vi.fn(async () => ({ containers: [], changed: false })),
            refreshAfterMutation: vi.fn(async () => {
                state.update(staleResult);
                return staleResult;
            }),
        };
        const provider = createProvider({ state, config, publicApi, sync });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'delete', containerId: 'container-1' });
        await flushMessages();

        expect(publicApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(config.removeContainer).toHaveBeenCalledWith(expect.anything(), 'container-1');
        expect(config.write).toHaveBeenCalledOnce();
        expect(sync.refreshAfterMutation).toHaveBeenCalledOnce();
        expect(view.webview.html).not.toContain('container-1');
    });

    it('marks container type badges and the sandbox access link', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('dev-1', 'running', true, undefined, undefined, undefined, {
                    containerType: 'testagent_cloud',
                }),
                syncedContainer('autotest-1', 'running', true, undefined, undefined, undefined, {
                    containerType: 'autotest_cloud',
                    novncUrl: 'http://127.0.0.1:59864/proxy/6080/vnc.html?host=127.0.0.1&port=59864&path=proxy/6080',
                }),
            ],
            changed: false,
        });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('type-badge-testagent');
        expect(view.webview.html).toContain('TestAgentCloud');
        expect(view.webview.html).toContain('type-badge-autotest');
        expect(view.webview.html).toContain('自动化跑批');
        expect(view.webview.html.match(/data-action="openNovnc"/g)).toHaveLength(1);
        expect(view.webview.html).toContain('沙箱访问');
    });

    it('opens the noVNC link in the external browser when sandbox access is clicked', async () => {
        const novncUrl = 'http://127.0.0.1:59864/proxy/6080/vnc.html?host=127.0.0.1&port=59864&path=proxy/6080';
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('autotest-1', 'running', true, undefined, undefined, undefined, {
                containerType: 'autotest_cloud',
                novncUrl,
            })],
            changed: false,
        });
        const view = createWebviewView();
        const provider = createProvider({ state, view });
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'openNovnc', containerId: 'autotest-1' });
        await flushMessages();

        expect(vscode.Uri.parse).toHaveBeenCalledWith(novncUrl);
        expect(vscode.env.openExternal).toHaveBeenCalledOnce();
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
        const values = ['https://gitee.com/alice/repo.git', 'main'];
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
        expect(showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: '码云仓库地址 (支持 HTTP 与 GIT 协议，可选)' }));
        expect(showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: '码云分支 (可选)' }));
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
                title: '正在创建云端沙箱 服务...',
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
            },
            expect.any(Function),
        );
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('云端沙箱 服务创建成功');
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
            host: '云端沙箱 服务',
            hostName: '10.0.0.6',
            port: 2222,
        }, { skipKnownHostsCheck: true, userName: 'root' });
    });

    it('rejects a manually entered Gitee username', async () => {
        const publicApi = createPublicApi();
        const values = ['alice'];
        const showInputBox = vi.fn(async () => values.shift());
        const showQuickPick = vi.fn(async () => []);
        const provider = createProvider({ publicApi, showInputBox, showQuickPick });

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledOnce();
        expect(showQuickPick).not.toHaveBeenCalled();
        expect(publicApi.createContainer).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('码云仓库地址格式无效', { modal: true });
    });

    it('does not write configuration when the create response has an invalid endpoint', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'created-2',
            status: 'pending',
            endpoint: 'example.com:22',
        }));
        const values = ['https://gitee.com/alice/repo', 'main'];
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

    it('connects when the service card itself is double-clicked', () => {
        const messages: unknown[] = [];
        const card = createScriptElement({
            'data-container-id': 'container-1',
            'data-connectable': 'true',
        });
        const connectButton = createScriptElement({
            'data-action': 'connect',
            'data-container-id': 'container-1',
            'data-connectable': 'true',
        });
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => {
                if (selector === '[data-action]') {
                    return [connectButton];
                }
                if (selector === '.container-card[data-container-id]') {
                    return [card];
                }
                if (selector === '[data-action="connect"]') {
                    return [connectButton];
                }
                return [];
            },
        };

        new Script(WEBVIEW_SCRIPT).runInNewContext({
            acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
            document,
            window: { addEventListener: () => undefined },
        });

        card.fire('dblclick', { target: card });

        expect(messages).toEqual([{ command: 'connect', containerId: 'container-1' }]);
        expect(connectButton.hasAttribute('disabled')).toBe(true);
        expect(connectButton.classList.contains('is-loading')).toBe(true);
    });
});

function syncedContainer(
    containerId: string,
    status: string,
    remote: boolean,
    expiresAt?: string,
    error?: SyncedContainer['error'],
    usage?: Pick<SyncedContainer, 'cpuUsage' | 'memoryUsage'>,
    extras: Partial<SyncedContainer> = {},
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
        ...(usage ?? {}),
        ...extras,
    };
}

interface ScriptElement {
    addEventListener(type: string, listener: (event: { target: ScriptElement }) => void): void;
    classList: {
        add(value: string): void;
        contains(value: string): boolean;
    };
    fire(type: string, event: { target: ScriptElement }): void;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    removeAttribute(name: string): void;
    setAttribute(name: string, value: string): void;
}

function createScriptElement(initialAttributes: Record<string, string>): ScriptElement {
    const attributes = new Map(Object.entries(initialAttributes));
    const classes = new Set<string>();
    const listeners = new Map<string, (event: { target: ScriptElement }) => void>();
    return {
        classList: {
            add: value => classes.add(value),
            contains: value => classes.has(value),
        },
        fire: (type, event) => listeners.get(type)?.(event),
        getAttribute: name => attributes.get(name) ?? null,
        hasAttribute: name => attributes.has(name),
        removeAttribute: name => { attributes.delete(name); },
        setAttribute: (name, value) => { attributes.set(name, value); },
        addEventListener: (type: string, listener: (event: { target: ScriptElement }) => void) => {
            listeners.set(type, listener);
        },
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
        operationRegistry: options.operationRegistry,
        showInputBox: options.showInputBox,
        showQuickPick: options.showQuickPick,
    });
}

interface ProviderTestOptions {
    state: SidebarSyncState;
    sync: {
        refresh: () => Promise<ContainerSyncResult>;
        refreshAfterMutation?: () => Promise<ContainerSyncResult>;
        runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
        markContainerDeleted?: (containerId: string) => void;
        clearContainerDeleted?: (containerId: string) => void;
    };
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
    operationRegistry?: ContainerOperationRegistry;
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
        getContainerStatuses: vi.fn(async () => ({ containers: [] })),
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
