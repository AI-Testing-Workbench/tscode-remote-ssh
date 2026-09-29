import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerConfig, ContainerConfigEntry } from '../src/containerConfig';
import { ContainerSyncResult, DEFAULT_CONTAINER_HOST_NAME, SyncedContainer } from '../src/containerSync';
import { ContainerOperationRegistry } from '../src/containerOperations';
import { createPublicUserContainerApi, PublicUserContainerApi } from '../src/api/publicApi';
import { UserRestApi } from '../src/api/restClient';
import { SidebarSyncState, SidebarViewProvider } from '../src/sidebarView';
import { WEBVIEW_SCRIPT } from '../src/webviewScript';
import { ContainerInitializationError } from '../src/containerInitializationPoller';
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
        vscode.env.clipboard.writeText.mockReset().mockResolvedValue(undefined);
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
                syncedContainer('syncing-1', 'syncing', false),
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
        expect(view.webview.html).toContain('<span class="status-dot failed"></span>\n                    <span class="status-label">已失败</span>');
        expect(view.webview.html).toContain('status-dot unknown');
        expect(view.webview.html).toContain('status-dot unknown error');
        expect(view.webview.html).toContain('status-dot missing');
        expect(view.webview.html).toContain('<span class="status-label">准备中</span>');
        expect(view.webview.html).toContain('<span class="status-dot pending"></span>\n                    <span class="status-label">同步中</span>');
        expect(view.webview.html).toContain('.status-dot.stopped, .status-dot.failed, .status-dot.error');
        expect(view.webview.html).toContain('data-action="connect"');
        expect((view.webview.html.match(/data-action="copyServiceId"/g) ?? [])).toHaveLength(7);
        expect(view.webview.html).toContain('title="复制云端沙箱标识码"');
        for (const serviceId of ['running-1', 'stopped-1', 'failed-1', 'pending-1', 'syncing-1', 'error-1', 'missing-1']) {
            expect(view.webview.html).toContain(`data-action="copyServiceId" data-service-id="${serviceId}"`);
        }
        expect(view.webview.html).toMatch(
            /<strong class="service-name">host-running-1<\/strong>\s*<button class="service-copy-button" data-action="copyServiceId" data-service-id="running-1"/,
        );
        expect(view.webview.html).toContain('post(\'connect\'');
        expect(view.webview.html).toMatch(/<article class="container-card" data-service-id="running-1" data-connectable="true">/);
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="running-1" data-connectable="true">/);
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="stopped-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="failed-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="pending-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="syncing-1" data-connectable="false" disabled>/);
        expect(view.webview.html).toMatch(/data-action="restart" data-service-id="failed-1" disabled>/);
        expect(view.webview.html).toMatch(/data-action="restart" data-service-id="stopped-1">/);
        expect(view.webview.html).not.toContain('data-action="openConfig"');
        expect(view.webview.html).toContain('data-action="refresh"');
        expect(view.webview.html).toContain('data-action="clearExpired"');
        expect(view.webview.html.indexOf('data-action="clearExpired"')).toBeLessThan(view.webview.html.indexOf('data-action="refresh"'));
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
        expect(view.webview.html).toContain('.action-button.is-confirming');
        expect(view.webview.html).toContain('justify-content: center');
        expect(view.webview.html).toContain('.app-bar { display: flex; align-items: center;');
        expect(view.webview.html).toContain('.sidebar { width: 100%; max-width: none; margin: 0; }');
        expect(view.webview.html).toContain('.icon-button { width: 32px; height: 32px; min-height: 32px;');
        expect(view.webview.html).toContain('.icon-button[data-action="clearExpired"] { width: 36px; height: 36px; min-height: 36px; flex: 0 0 36px;');
        expect(view.webview.html).toContain('.icon-button[data-action="clearExpired"] .icon { width: 22px; height: 22px; }');
        expect(view.webview.html).toContain('.empty-state .cloud-icon { margin-bottom: 7px; color: var(--primary); }');
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

    it('copies the service ID for a service card', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('service-copy-me', 'running', true)], changed: false });
        const view = createWebviewView();
        const provider = createProvider({ state, view });
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'copyServiceId', serviceId: 'service-copy-me', requestId: 'copy-1' });
        await flushMessages();

        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('service-copy-me');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('云端沙箱标识码已复制，请按需联系支持人员获取帮助');
    });

    it('does not copy an ID that does not belong to a visible service card', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('known-id', 'running', true)], changed: false });
        const view = createWebviewView();
        const provider = createProvider({ state, view });
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'copyServiceId', serviceId: 'forged-id' });
        await flushMessages();

        expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '无法复制 ID',
            { modal: true },
        );
    });

    it('renders an empty state without a creation instruction when no containers exist', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('class="empty-state"');
        expect(view.webview.html).toContain('还没有 云端沙箱 服务');
        expect(view.webview.html).toContain('当前没有可用的容器');
        expect(view.webview.html).toContain('<div class="cloud-icon empty-cloud-icon" aria-hidden="true">');
        expect(view.webview.html).not.toContain('请使用 测小智TestAgent 插件进行创建');
    });

    it('renders local syncing cards before user initialization completes', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('syncing-1', 'syncing', false)],
            changed: false,
        });
        let resolveUserId: ((userId: string) => void) | undefined;
        const view = createWebviewView();
        const provider = createProvider({
            state,
            userIdProvider: {
                getCurrentUserId: () => new Promise<string>(resolve => {
                    resolveUserId = resolve;
                }),
            },
            view,
        });

        const resolving = provider.resolveWebviewView(view as never);
        await vi.waitFor(() => expect(view.webview.html).toContain('<span class="status-label">同步中</span>'));
        expect(view.webview.html).toContain('data-service-id="syncing-1"');
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="syncing-1" data-connectable="false" disabled>/);

        resolveUserId?.('user-1');
        await resolving;
    });

    it('keeps the error page when the initial sync fails after local cards render', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('syncing-1', 'syncing', false)],
            changed: false,
        });
        const view = createWebviewView();
        const provider = createProvider({ state, view });

        await provider.resolveWebviewView(view as never);
        expect(view.webview.html).toContain('<span class="status-label">同步中</span>');

        state.update({
            containers: [syncedContainer('syncing-1', 'unknown', false, undefined, {
                code: 'sync_failed',
                message: '获取服务清单失败',
            })],
            changed: false,
            error: { code: 'sync_failed', message: '获取服务清单失败' },
        });

        expect(view.webview.html).toContain('class="error-page"');
        expect(view.webview.html).toContain('获取服务清单失败');
        expect(view.webview.html).not.toContain('同步中');
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
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="container-1" data-connectable="false" disabled>/);
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
        const provider = createProvider({
            cloudMode: true,
            view,
        });

        await provider.resolveWebviewView(view as never);

        expect(view.webview.html).toContain('当前已连接至 云端沙箱 服务中');
        expect(view.webview.html).toContain('.cloud-card { min-height: 150px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 6px; padding: 14px; border: 2px solid var(--warning);');
        expect(view.webview.html).toContain('.cloud-card p { margin: 0 0 6px; color: var(--warning);');
        expect(view.webview.html).toContain('.cloud-card .action-button { width: 100%; max-width: 160px; max-height: 28px; padding: 0 12px; }');
        expect(view.webview.html).toContain('data-action="disconnect"');
        expect(view.webview.html).not.toContain('data-action="refresh"');
        expect(view.webview.html).not.toContain('data-action="openConfig"');
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

    it('starts and stops polling when the mode changes', async () => {
        let cloudMode = false;
        const start = vi.fn();
        const stop = vi.fn();
        const view = createWebviewView();
        const getCloudMode = vi.fn(() => cloudMode);
        const provider = createProvider({
            view,
            getCloudMode,
            sync: {
                refresh: vi.fn(async () => ({ containers: [], changed: false })),
                start,
                stop,
            },
        });

        await provider.resolveWebviewView(view as never);
        cloudMode = true;
        view.fireVisibility(true);
        await flushMessages();
        cloudMode = false;
        view.fireVisibility(true);
        await flushMessages();

        expect(stop).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
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
        expect(view.webview.html).toContain('data-action="refresh"');
        expect(userIdProvider.getCurrentUserId).not.toHaveBeenCalled();
    });

    it('retries page preparation from the error page', async () => {
        let backendApiUrl = '';
        const view = createWebviewView();
        const provider = createProvider({ view, getSettings: () => settings(backendApiUrl) });

        await provider.resolveWebviewView(view as never);
        expect(view.webview.html).toContain('data-action="refresh"');

        backendApiUrl = 'https://api.example.test';
        view.fireMessage({ command: 'refresh', requestId: 'error-retry-1' });
        await flushMessages();

        expect(view.webview.html).not.toContain('未配置后端 云端沙箱 管理服务的 API 地址');
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'refresh',
            requestId: 'error-retry-1',
            outcome: 'succeeded',
        }));
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
        const provider = createProvider({ state, userApi, publicApi, sync, onConnect, config: createConfig([configuredContainer('container-1')]) });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'connect', serviceId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'restart', serviceId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'delete', serviceId: 'container-1' });
        await flushMessages();
        view.fireMessage({ command: 'executeCommand', commandId: 'workbench.action.remote.close' });
        await flushMessages();

        expect(onConnect).toHaveBeenCalledWith('host-container-1');
        expect(publicApi.restartContainer).toHaveBeenCalledWith('container-1');
        expect(publicApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(sync.refresh).toHaveBeenCalledTimes(2);
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.remote.close');
    });

    it('reads the current ServiceId config before connecting a service', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('slash-alias', 'running', true, undefined, undefined, undefined, { giteeRepository: 'repo' }),
                syncedContainer('space-alias', 'running', true),
            ],
            changed: false,
        });
        const onConnect = vi.fn();
        const config = createConfig([
            configuredContainer('slash-alias', 'alice/repo'),
            configuredContainer('space-alias', 'TestAgent Cloud Service'),
        ]);
        const provider = createProvider({ state, config, onConnect });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'connect', serviceId: 'slash-alias' });
        view.fireMessage({ command: 'connect', serviceId: 'space-alias' });
        await flushMessages();

        expect(onConnect).toHaveBeenNthCalledWith(1, 'alice/repo', 'repo');
        expect(onConnect).toHaveBeenNthCalledWith(2, 'TestAgent Cloud Service');
    });

    it('rejects a service when the current ServiceId endpoint is invalid', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('invalid-endpoint', 'running', true)],
            changed: false,
        });
        const onConnect = vi.fn();
        const config = createConfig([configuredContainer('invalid-endpoint', 'service alias', 'example.com')]);
        const provider = createProvider({ state, config, onConnect });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'connect', serviceId: 'invalid-endpoint' });
        await flushMessages();

        expect(onConnect).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "invalid-endpoint" 的 endpoint 无效，必须是 IP:Port',
            { modal: true },
        );
    });

    it('ignores a duplicate request ID while a connection is in flight', async () => {
        let resolveConnect: (() => void) | undefined;
        const connect = new Promise<void>(resolve => {
            resolveConnect = resolve;
        });
        const onConnect = vi.fn(() => connect);
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('container-1', 'running', true)], changed: false });
        const provider = createProvider({
            state,
            config: createConfig([configuredContainer('container-1')]),
            onConnect,
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'connect', serviceId: 'container-1', requestId: 'request-1' });
        view.fireMessage({ command: 'connect', serviceId: 'container-1', requestId: 'request-1' });
        view.fireMessage({ command: 'connect', serviceId: 'container-1', requestId: 'request-2' });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
        expect(onConnect).toHaveBeenCalledWith('host-container-1');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "container-1" 正在执行操作，暂时无法连接',
            { modal: true },
        );

        resolveConnect?.();
        await flushMessages();
    });

    it('keeps a refresh action loading when state rendering occurs during the request', async () => {
        let resolveRefresh: ((value: ContainerSyncResult) => void) | undefined;
        const refresh = vi.fn(() => new Promise<ContainerSyncResult>(resolve => {
            resolveRefresh = resolve;
        }));
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const provider = createProvider({ state, sync: { refresh } });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'refresh', requestId: 'refresh-1' });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(view.webview.html).toContain('class="icon-button is-loading" data-action="refresh"');

        state.update({ containers: [], changed: false });

        expect(view.webview.html).toContain('class="icon-button is-loading" data-action="refresh"');
        resolveRefresh?.({ containers: [], changed: false });
        await flushMessages();

        expect(view.webview.html).not.toContain('class="icon-button is-loading" data-action="refresh"');
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'operationComplete',
            action: 'refresh',
            requestId: 'refresh-1',
            outcome: 'succeeded',
        }));
    });

    it('keeps the current message session after a visibility refresh', async () => {
        let resolveRefresh: ((value: ContainerSyncResult) => void) | undefined;
        const refresh = vi.fn(() => new Promise<ContainerSyncResult>(resolve => {
            resolveRefresh = resolve;
        }));
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const provider = createProvider({ state, sync: { refresh } });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'refresh', requestId: 'refresh-visibility-1' });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        view.fireVisibility(true);
        await flushMessages();

        resolveRefresh?.({ containers: [], changed: false });
        await flushMessages();

        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'operationComplete',
            action: 'refresh',
            requestId: 'refresh-visibility-1',
        }));
    });

    it('does not finish an old page initialization after the view is disposed', async () => {
        let resolveUserId: ((value: string) => void) | undefined;
        const userId = new Promise<string>(resolve => {
            resolveUserId = resolve;
        });
        const provider = createProvider({ userIdProvider: { getCurrentUserId: () => userId } });
        const view = createWebviewView();
        const resolving = provider.resolveWebviewView(view as never);

        view.dispose();
        resolveUserId?.('user-1');
        await resolving;

        expect(view.webview.options).toEqual({});
        expect(view.webview.html).toBe('');
    });

    it('keeps the newest administrator check when a visibility refresh overlaps it', async () => {
        let resolveFirstCheck: ((value: { admin: boolean; limit: 'user' | 'none' }) => void) | undefined;
        let resolveSecondCheck: ((value: { admin: boolean; limit: 'user' | 'none' }) => void) | undefined;
        const firstCheck = new Promise<{ admin: boolean; limit: 'user' | 'none' }>(resolve => {
            resolveFirstCheck = resolve;
        });
        const secondCheck = new Promise<{ admin: boolean; limit: 'user' | 'none' }>(resolve => {
            resolveSecondCheck = resolve;
        });
        const checkAdmin = vi.fn()
            .mockImplementationOnce(() => firstCheck)
            .mockImplementationOnce(() => secondCheck);
        const provider = createProvider({
            publicApi: {
                ...createPublicApi(),
                checkAdmin,
            },
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);
        await vi.waitFor(() => expect(checkAdmin).toHaveBeenCalledOnce());

        view.fireVisibility(true);
        await vi.waitFor(() => expect(checkAdmin).toHaveBeenCalledTimes(2));
        resolveSecondCheck?.({ admin: true, limit: 'none' });
        await flushMessages();
        resolveFirstCheck?.({ admin: false, limit: 'user' });
        await flushMessages();

        expect(view.webview.html).toContain('data-action="openAdmin"');
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
        const provider = createProvider({
            state,
            onConnect,
            config: createConfig([
                configuredContainer('running-1'),
                configuredContainer('stopped-1'),
                configuredContainer('failed-1'),
                configuredContainer('pending-1'),
            ]),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        for (const serviceId of ['running-1', 'stopped-1', 'failed-1', 'pending-1']) {
            view.fireMessage({ command: 'connect', serviceId });
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

        view.fireMessage({ command: 'restart', serviceId: 'failed-1' });
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
        const provider = createProvider({
            state,
            publicApi,
            onConnect,
            config: createConfig([configuredContainer('running-1')]),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'restart', serviceId: 'running-1' });
        await vi.waitFor(() => expect(publicApi.restartContainer).toHaveBeenCalledOnce());
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="running-1" data-connectable="false" disabled>/);

        view.fireMessage({ command: 'connect', serviceId: 'running-1' });
        await flushMessages();

        expect(onConnect).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('正在执行操作'),
            { modal: true },
        );

        releaseRestart?.();
        await flushMessages();
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="running-1" data-connectable="true">/);
    });

    it('allows refresh while the remote restart request is still pending', async () => {
        let resolveRestart: (() => void) | undefined;
        const publicApi = createPublicApi();
        publicApi.restartContainer = vi.fn(() => new Promise<void>(resolve => {
            resolveRestart = resolve;
        }));
        const refresh = vi.fn(async () => ({ containers: [], changed: false }));
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('refreshable-1', 'running', true)], changed: false });
        const provider = createProvider({
            state,
            publicApi,
            sync: { refresh },
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'restart', serviceId: 'refreshable-1', requestId: 'restart-refresh-1' });
        await vi.waitFor(() => expect(publicApi.restartContainer).toHaveBeenCalledOnce());
        view.fireMessage({ command: 'refresh', requestId: 'refresh-during-restart-1' });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());

        resolveRestart?.();
        await flushMessages();
    });

    it('allows another container to connect while the first container restarts', async () => {
        let resolveRestart: (() => void) | undefined;
        const publicApi = createPublicApi();
        publicApi.restartContainer = vi.fn(() => new Promise<void>(resolve => {
            resolveRestart = resolve;
        }));
        const onConnect = vi.fn(async () => undefined);
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('restart-1', 'running', true),
                syncedContainer('connect-2', 'running', true),
            ],
            changed: false,
        });
        const operationRegistry = new ContainerOperationRegistry();
        const provider = createProvider({
            state,
            publicApi,
            operationRegistry,
            onConnect,
            config: createConfig([configuredContainer('restart-1'), configuredContainer('connect-2')]),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'restart', serviceId: 'restart-1', requestId: 'restart-1' });
        await vi.waitFor(() => expect(publicApi.restartContainer).toHaveBeenCalledOnce());
        expect(view.webview.html).toMatch(/data-action="connect" data-service-id="connect-2" data-connectable="true">/);
        view.fireMessage({ command: 'connect', serviceId: 'connect-2', requestId: '1' });
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

        expect(onConnect).toHaveBeenCalledWith('host-connect-2');
        resolveRestart?.();
        await flushMessages();
    });

    it('reports a cancelled connection without showing an error', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('cancelled-1', 'running', true)], changed: false });
        const onConnect = vi.fn(async () => false);
        const view = createWebviewView();
        const provider = createProvider({
            state,
            view,
            onConnect,
            config: createConfig([configuredContainer('cancelled-1')]),
        });

        await provider.resolveWebviewView(view as never);
        view.fireMessage({ command: 'connect', serviceId: 'cancelled-1', requestId: 'cancelled-1' });
        await flushMessages();

        expect(onConnect).toHaveBeenCalledOnce();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'connect',
            requestId: 'cancelled-1',
            outcome: 'cancelled',
        }));
    });

    it('keeps lifecycle controls in reconciling until sync confirms the restart', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [syncedContainer('restarting-1', 'running', true)], changed: false });
        const operationRegistry = new ContainerOperationRegistry();
        const reconcileContainerOperation = vi.fn(async () => false);
        const publicApi = createPublicApi();
        const view = createWebviewView();
        const provider = createProvider({
            state,
            view,
            publicApi,
            operationRegistry,
            sync: {
                refresh: vi.fn(async () => ({ containers: [], changed: false })),
                reconcileContainerOperation,
            },
        });

        await provider.resolveWebviewView(view as never);
        view.fireMessage({ command: 'restart', serviceId: 'restarting-1', requestId: 'restart-1' });
        await flushMessages();

        expect(reconcileContainerOperation).toHaveBeenCalledOnce();
        expect(operationRegistry.get('restarting-1')?.phase).toBe('reconciling');
        expect(view.webview.html).toContain('重启中');
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'restart',
            requestId: 'restart-1',
            outcome: 'pending',
        }));
        provider.dispose();
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

        view.fireMessage({ command: 'delete', serviceId: 'container-1' });
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

        view.fireMessage({ command: 'openNovnc', serviceId: 'autotest-1' });
        await flushMessages();

        expect(vscode.Uri.parse).toHaveBeenCalledWith(novncUrl);
        expect(vscode.env.openExternal).toHaveBeenCalledOnce();
    });

    it('reports when the external browser rejects a noVNC link', async () => {
        const novncUrl = 'http://127.0.0.1:59864/proxy/6080/vnc.html';
        const state = new SidebarSyncState();
        state.update({
            containers: [syncedContainer('autotest-1', 'running', true, undefined, undefined, undefined, { novncUrl })],
            changed: false,
        });
        vscode.env.openExternal.mockResolvedValueOnce(false);
        const view = createWebviewView();
        const provider = createProvider({ state, view });
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'openNovnc', serviceId: 'autotest-1', requestId: 'novnc-1' });
        await flushMessages();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('无法打开沙箱访问链接', { modal: true });
        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'openNovnc',
            requestId: 'novnc-1',
            outcome: 'failed',
        }));
    });

    it('shows the administrator entry only after /user/check grants access', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const userApi = createUserApi(true);
        const onOpenAdmin = vi.fn();
        const onOpenConfig = vi.fn();
        const view = createWebviewView();
        const provider = createProvider({ state, userApi, onOpenAdmin, onOpenConfig, view });

        await provider.resolveWebviewView(view as never);
        await flushMessages();

        expect(view.webview.html).toContain('data-action="openAdmin"');
        expect(view.webview.html.indexOf('data-action="openAdmin"')).toBeLessThan(view.webview.html.indexOf('data-action="openConfig"'));
        expect(view.webview.html.indexOf('data-action="openConfig"')).toBeLessThan(view.webview.html.indexOf('data-action="refresh"'));
        view.fireMessage({ command: 'openAdmin' });
        await flushMessages();
        expect(onOpenAdmin).toHaveBeenCalledOnce();
        view.fireMessage({ command: 'openConfig' });
        await flushMessages();
        expect(onOpenConfig).toHaveBeenCalledOnce();
    });

    it('hides and rejects config-file access for non-admin users', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const userApi = createUserApi(false);
        const onOpenConfig = vi.fn();
        const view = createWebviewView();
        const provider = createProvider({ state, userApi, onOpenConfig, view });

        await provider.resolveWebviewView(view as never);
        await flushMessages();

        expect(view.webview.html).not.toContain('data-action="openConfig"');
        view.fireMessage({ command: 'openConfig' });
        await flushMessages();

        expect(onOpenConfig).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('当前用户没有管理员权限', { modal: true });
        await expect(provider.openConfigFile()).rejects.toThrow('当前用户没有管理员权限');
        expect(onOpenConfig).not.toHaveBeenCalled();
    });

    it('waits for the administrator page to finish opening', async () => {
        let resolveOpen: (() => void) | undefined;
        const onOpenAdmin = vi.fn(() => new Promise<void>(resolve => {
            resolveOpen = resolve;
        }));
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const userApi = createUserApi(true);
        const view = createWebviewView();
        const provider = createProvider({ state, userApi, onOpenAdmin, view });

        await provider.resolveWebviewView(view as never);
        await flushMessages();
        view.fireMessage({ command: 'openAdmin', requestId: 'admin-1' });
        await flushMessages();

        expect(onOpenAdmin).toHaveBeenCalledOnce();
        expect(view.webview.postMessage).not.toHaveBeenCalled();

        resolveOpen?.();
        await flushMessages();

        expect(view.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            action: 'openAdmin',
            requestId: 'admin-1',
            outcome: 'succeeded',
        }));
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

        view.fireMessage({ command: 'removeHistory', serviceId: 'history-1' });
        await flushMessages();

        expect(config.removeContainer).toHaveBeenCalledWith(expect.anything(), 'history-1');
        expect(config.write).toHaveBeenCalledOnce();
        expect(publicApi.deleteContainer).not.toHaveBeenCalled();
    });

    it('clears all expired local entries without calling a remote delete API', async () => {
        const state = new SidebarSyncState();
        state.update({
            containers: [
                syncedContainer('history-1', 'missing', false, '2026-09-01T00:00:00.000Z'),
                syncedContainer('history-2', 'missing', false, '2026-09-02T00:00:00.000Z'),
            ],
            changed: false,
        });
        const config = createConfig([
            { ...configuredContainer('history-1'), expiresAt: '2026-09-01T00:00:00.000Z' },
            { ...configuredContainer('history-2'), expiresAt: '2026-09-02T00:00:00.000Z' },
            configuredContainer('active-1'),
        ]);
        const publicApi = createPublicApi();
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const provider = createProvider({ state, config, publicApi, sync });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        view.fireMessage({ command: 'clearExpired' });
        await flushMessages();

        expect(config.removeContainer).toHaveBeenNthCalledWith(1, expect.anything(), 'history-1');
        expect(config.removeContainer).toHaveBeenNthCalledWith(2, expect.anything(), 'history-2');
        expect(config.write).toHaveBeenCalledOnce();
        expect(publicApi.deleteContainer).not.toHaveBeenCalled();
        expect(sync.refresh).toHaveBeenCalledOnce();
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
        expect(view.webview.html).toContain('data-service-id="deleted-in-cloud"');
    });

    it('creates a user container, validates its endpoint, and writes only user fields', async () => {
        const state = new SidebarSyncState();
        state.update({ containers: [], changed: false });
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            container_id: 'physical-created-1',
            service_id: 'service-created-1',
            status: 'pending',
            endpoint: '10.0.0.5:2222',
        } as never));
        const values = ['https://gitee.com/alice/repo.git', 'main'];
        const showInputBox = vi.fn(async () => values.shift());
        const sync = { refresh: vi.fn(async () => ({ containers: [], changed: false })) };
        const provider = createProvider({ state, config, publicApi, sync, showInputBox });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(publicApi.createContainer).toHaveBeenCalledWith({
            plugin_id: 'test-tech.tscode-remote-ssh',
            gitee_url: 'https://gitee.com',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
        }, { initializationSignal: expect.any(AbortSignal) });
        expect(showInputBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
            prompt: '码云仓库地址 (HTTP协议)',
            ignoreFocusOut: true,
        }));
        expect(showInputBox).toHaveBeenNthCalledWith(2, expect.objectContaining({
            prompt: '码云分支 (可选)',
            ignoreFocusOut: true,
        }));
        expect(config.upsertContainer).toHaveBeenCalledWith(expect.anything(), {
            serviceId: 'service-created-1',
            host: 'alice/repo',
            name: 'alice/repo',
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

    it('extracts 码云 fields from a repository URL and only asks for the branch', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            service_id: 'service-created-from-url',
            status: 'pending',
            endpoint: '10.0.0.7:2222',
        }));
        const values = ['https://github.com/JustWorkingAndWorking/testagent-cloud-remote-ssh.git', 'develop'];
        const showInputBox = vi.fn(async () => values.shift());
        const provider = createProvider({ config, publicApi, showInputBox });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledTimes(2);
        expect(publicApi.createContainer).toHaveBeenCalledWith({
            plugin_id: 'test-tech.tscode-remote-ssh',
            gitee_url: 'https://github.com',
            gitee_user: 'JustWorkingAndWorking',
            gitee_repository: 'testagent-cloud-remote-ssh',
            gitee_branch: 'develop',
        }, { initializationSignal: expect.any(AbortSignal) });
    });

    it('keeps the existing flow when the 码云 input is blank', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            service_id: 'service-created-without-gitee',
            status: 'pending',
            endpoint: '10.0.0.6:2222',
        }));
        const values = ['   '];
        const showInputBox = vi.fn(async () => values.shift());
        const provider = createProvider({ config, publicApi, showInputBox });

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledOnce();
        expect(publicApi.createContainer).toHaveBeenCalledWith(
            { plugin_id: 'test-tech.tscode-remote-ssh' },
            { initializationSignal: expect.any(AbortSignal) },
        );
        expect(config.upsertContainer).toHaveBeenCalledWith(expect.anything(), {
            serviceId: 'service-created-without-gitee',
            host: DEFAULT_CONTAINER_HOST_NAME,
            name: DEFAULT_CONTAINER_HOST_NAME,
            hostName: '10.0.0.6',
            port: 2222,
        }, { skipKnownHostsCheck: true, userName: 'root' });
    });

    it('rejects a manually entered 码云 username', async () => {
        const publicApi = createPublicApi();
        const values = ['alice'];
        const showInputBox = vi.fn(async () => values.shift());
        const provider = createProvider({ publicApi, showInputBox });

        await provider.createContainerFromPrompt();

        expect(showInputBox).toHaveBeenCalledOnce();
        expect(publicApi.createContainer).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('码云仓库地址格式无效', { modal: true });
    });

    it('does not write configuration when the create response has an invalid endpoint', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => ({
            service_id: 'service-created-2',
            status: 'pending',
            endpoint: 'example.com:22',
        }));
        const values = ['https://gitee.com/alice/repo', 'main'];
        const showInputBox = vi.fn(async () => values.shift());
        const provider = createProvider({ config, publicApi, showInputBox });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        await provider.createContainerFromPrompt();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "service-created-2" 的 endpoint 无效，应为 IP:Port 格式：example.com:22',
            { modal: true },
        );
        expect(config.read).not.toHaveBeenCalled();
        expect(config.upsertContainer).not.toHaveBeenCalled();
        expect(config.write).not.toHaveBeenCalled();
    });

    it('shows the initialization failure code in the sidebar error dialog', async () => {
        const publicApi = createPublicApi();
        publicApi.createContainer = vi.fn(async () => {
            throw new ContainerInitializationError('failed_initialize', '码云初始化失败');
        });
        const provider = createProvider({
            publicApi,
            showInputBox: vi.fn(async () => ''),
        });

        await provider.createContainerFromPrompt();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('码云初始化失败\n错误码: failed_initialize', { modal: true });
    });

    it('waits for public 码云 initialization before validating a null endpoint', async () => {
        const userApi = createUserApi(false);
        userApi.createContainer = vi.fn(async () => ({
            container_id: 'physical-created-after-git',
            service_id: 'service-created-after-git',
            status: 'pending',
            endpoint: null,
        } as never));
        let resolveInitialization: (() => void) | undefined;
        const initialization = new Promise<void>(resolve => {
            resolveInitialization = resolve;
        });
        const initializationPoller = { initialize: vi.fn(() => initialization) };
        const publicApi = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });
        const config = createConfig();
        const values = [''];
        const provider = createProvider({
            publicApi,
            config,
            showInputBox: vi.fn(async () => values.shift()),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        const creating = provider.createContainerFromPrompt();
        await vi.waitFor(() => expect(initializationPoller.initialize).toHaveBeenCalledOnce());
        expect(config.upsertContainer).not.toHaveBeenCalled();
        resolveInitialization?.();
        await creating;

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '服务 "service-created-after-git" 的 endpoint 无效，应为 IP:Port 格式：(空)',
            { modal: true },
        );
        expect(config.upsertContainer).not.toHaveBeenCalled();
    });

    it('does not hold the mutation lock while public 码云 initialization is waiting', async () => {
        const config = createConfig();
        const publicApi = createPublicApi();
        type CreatedResponse = Awaited<ReturnType<PublicUserContainerApi['createContainer']>>;
        let resolveCreation: ((value: CreatedResponse) => void) | undefined;
        publicApi.createContainer = vi.fn(() => new Promise<CreatedResponse>(resolve => {
            resolveCreation = resolve;
        }));
        const runMutation = vi.fn(async (operation: () => Promise<unknown>) => operation());
        const sync = {
            refresh: vi.fn(async () => ({ containers: [], changed: false })),
            runMutation: runMutation as unknown as ProviderTestOptions['sync']['runMutation'],
        } as ProviderTestOptions['sync'];
        const provider = createProvider({
            publicApi,
            config,
            sync,
            showInputBox: vi.fn(async () => ''),
        });

        const creating = provider.createContainerFromPrompt();
        await vi.waitFor(() => expect(publicApi.createContainer).toHaveBeenCalledOnce());
        expect(runMutation).not.toHaveBeenCalled();
        resolveCreation?.({
            service_id: 'service-after-wait',
            status: 'pending',
            endpoint: '10.0.0.8:2222',
        });
        await creating;

        expect(runMutation).toHaveBeenCalledOnce();
        expect(config.write).toHaveBeenCalledOnce();
    });

    it('aborts public initialization when its sidebar view is disposed', async () => {
        const userApi = createUserApi(false);
        userApi.createContainer = vi.fn(async () => ({
            service_id: 'service-before-dispose',
            status: 'pending',
            endpoint: '10.0.0.9:2222',
        }));
        const initializationPoller = {
            initialize: vi.fn(({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('creation cancelled')));
            })),
        };
        const publicApi = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });
        const config = createConfig();
        const provider = createProvider({
            publicApi,
            config,
            showInputBox: vi.fn(async () => ''),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        const creating = provider.createContainerFromPrompt();
        await vi.waitFor(() => expect(initializationPoller.initialize).toHaveBeenCalledOnce());
        view.dispose();
        await creating;

        expect((initializationPoller.initialize.mock.calls[0][0] as { signal: AbortSignal }).signal.aborted).toBe(true);
        expect(config.write).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('creation cancelled', { modal: true });
    });

    it('keeps public initialization alive while switching sidebars', async () => {
        const userApi = createUserApi(false);
        userApi.createContainer = vi.fn(async () => ({
            container_id: 'physical-during-sidebar-switch',
            service_id: 'service-during-sidebar-switch',
            status: 'pending',
            endpoint: '10.0.0.10:2222',
        } as never));
        let resolveInitialization: ((value: unknown) => void) | undefined;
        let initializationSignal: AbortSignal | undefined;
        const initialization = new Promise<unknown>(resolve => {
            resolveInitialization = resolve;
        });
        const initializationPoller = {
            initialize: vi.fn((input: { signal?: AbortSignal }) => {
                initializationSignal = input.signal;
                return initialization;
            }),
        };
        const publicApi = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });
        const config = createConfig();
        const provider = createProvider({
            publicApi,
            config,
            showInputBox: vi.fn(async () => ''),
        });
        const view = createWebviewView();
        await provider.resolveWebviewView(view as never);

        const creating = provider.createContainerFromPrompt();
        await vi.waitFor(() => expect(initializationPoller.initialize).toHaveBeenCalledOnce());

        for (let index = 0; index < 3; index += 1) {
            view.fireVisibility(false);
            view.fireVisibility(true);
        }

        expect(initializationSignal?.aborted).toBe(false);
        resolveInitialization?.({
            container: {
                service_id: 'service-during-sidebar-switch',
                status: 'running',
                endpoint: '10.0.0.10:2222',
                git_fin_status: 'initialized',
            },
        });
        await creating;

        expect(config.write).toHaveBeenCalledOnce();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('当前创建流程已取消\n错误码: creation_cancelled', { modal: true });
        provider.dispose();
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
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const connectButton = createScriptElement({
            'data-action': 'connect',
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => {
                if (selector === '[data-action]') {
                    return [connectButton];
                }
                if (selector === '.container-card[data-service-id]') {
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

        expect(messages).toEqual([{ command: 'connect', serviceId: 'service-1', requestId: '1' }]);
        expect(connectButton.hasAttribute('disabled')).toBe(true);
        expect(connectButton.classList.contains('is-loading')).toBe(true);
    });

    it('copies a service ID when its button is clicked without connecting the card', () => {
        const messages: unknown[] = [];
        const card = createScriptElement({
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const copyButton = createScriptElement({
            'data-action': 'copyServiceId',
            'data-service-id': 'service-1',
        });
        const connectButton = createScriptElement({
            'data-action': 'connect',
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => {
                if (selector === '[data-action]') {
                    return [copyButton, connectButton];
                }
                if (selector === '.container-card[data-service-id]') {
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

        copyButton.fire('click', { target: copyButton });
        card.fire('dblclick', { target: copyButton });

        expect(messages).toEqual([{ command: 'copyServiceId', serviceId: 'service-1', requestId: '1' }]);
        expect(copyButton.hasAttribute('disabled')).toBe(true);
        expect(connectButton.hasAttribute('disabled')).toBe(false);
    });

    it('sets the request ID before a synchronous completion message is delivered', () => {
        const messages: unknown[] = [];
        let messageListener: ((event: { data: unknown }) => void) | undefined;
        const refreshButton = createScriptElement({ 'data-action': 'refresh' });
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => selector === '[data-action]'
                ? [refreshButton]
                : [],
        };

        new Script(WEBVIEW_SCRIPT).runInNewContext({
            acquireVsCodeApi: () => ({
                postMessage: (message: Record<string, unknown>) => {
                    messages.push(message);
                    messageListener?.({ data: { command: 'operationComplete', action: 'refresh', requestId: '1', outcome: 'succeeded' } });
                },
            }),
            document,
            window: {
                addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
                    messageListener = listener;
                },
            },
        });

        refreshButton.fire('click', { target: refreshButton });

        expect(messages).toEqual([{ command: 'refresh', requestId: '1' }]);
        expect(refreshButton.classList.contains('is-loading')).toBe(false);
        expect(refreshButton.hasAttribute('disabled')).toBe(false);
        expect(refreshButton.getAttribute('data-request-id')).toBeNull();
    });

    it('does not unlock a connection button from an old lifecycle completion', () => {
        const messages: unknown[] = [];
        let messageListener: ((event: { data: unknown }) => void) | undefined;
        const card = createScriptElement({
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const connectButton = createScriptElement({
            'data-action': 'connect',
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const restartButton = createScriptElement({
            'data-action': 'restart',
            'data-service-id': 'service-1',
        }, '<svg>restart</svg>重启');
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => {
                if (selector === '[data-action]') {
                    return [connectButton, restartButton];
                }
                if (selector === '.container-card[data-service-id]') {
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
            window: {
                addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
                    messageListener = listener;
                },
                clearTimeout,
                setTimeout,
            },
        });

        restartButton.fire('click', { target: restartButton });
        restartButton.fire('click', { target: restartButton });
        expect(connectButton.hasAttribute('disabled')).toBe(true);

        messageListener?.({
            data: {
                command: 'operationComplete',
                action: 'restart',
                serviceId: 'service-1',
                requestId: 'old-request',
            },
        });

        expect(connectButton.hasAttribute('disabled')).toBe(true);
        expect(messages).toEqual([{ command: 'restart', serviceId: 'service-1', requestId: '1' }]);
    });

    it('does not connect when a card child action is double-clicked', () => {
        const messages: unknown[] = [];
        const card = createScriptElement({
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const connectButton = createScriptElement({
            'data-action': 'connect',
            'data-service-id': 'service-1',
            'data-connectable': 'true',
        });
        const openButton = createScriptElement({
            'data-action': 'openNovnc',
            'data-service-id': 'service-1',
        });
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => {
                if (selector === '[data-action]') {
                    return [connectButton, openButton];
                }
                if (selector === '.container-card[data-service-id]') {
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

        card.fire('dblclick', { target: openButton });

        expect(messages).toEqual([]);
        expect(connectButton.classList.contains('is-loading')).toBe(false);
    });

    it('requires confirmation for restart and delete, and expires it after five seconds', () => {
        vi.useFakeTimers();
        const messages: unknown[] = [];
        const restartButton = createScriptElement({
            'data-action': 'restart',
            'data-service-id': 'service-1',
        }, '<svg>restart</svg>重启');
        const deleteButton = createScriptElement({
            'data-action': 'delete',
            'data-service-id': 'service-1',
        }, '<svg>delete</svg>销毁');
        const document = {
            querySelectorAll: (selector: string): ScriptElement[] => selector === '[data-action]'
                ? [restartButton, deleteButton]
                : [],
        };

        new Script(WEBVIEW_SCRIPT).runInNewContext({
            acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
            document,
            window: {
                addEventListener: () => undefined,
                clearTimeout,
                setTimeout,
            },
        });

        restartButton.fire('click', { target: restartButton });

        expect(messages).toEqual([]);
        expect(restartButton.classList.contains('is-confirming')).toBe(true);
        expect(restartButton.innerHTML).toBe('确认?');

        restartButton.fire('click', { target: restartButton });

        expect(messages).toEqual([{ command: 'restart', serviceId: 'service-1', requestId: '1' }]);
        expect(restartButton.classList.contains('is-loading')).toBe(true);

        deleteButton.fire('click', { target: deleteButton });
        expect(deleteButton.classList.contains('is-confirming')).toBe(true);
        vi.advanceTimersByTime(5000);

        expect(deleteButton.classList.contains('is-confirming')).toBe(false);
        expect(deleteButton.innerHTML).toBe('<svg>delete</svg>销毁');
        expect(messages).toHaveLength(1);

        deleteButton.fire('click', { target: deleteButton });
        deleteButton.fire('click', { target: deleteButton });

        expect(messages).toEqual([
            { command: 'restart', serviceId: 'service-1', requestId: '1' },
            { command: 'delete', serviceId: 'service-1', requestId: '2' },
        ]);
    });

    it('restores destructive confirmation after the document is rebuilt', () => {
        vi.useFakeTimers();
        let viewState: Record<string, unknown> = {};
        const messages: unknown[] = [];
        const api = {
            getState: () => viewState,
            setState: (state: Record<string, unknown>) => {
                viewState = state;
            },
            postMessage: (message: unknown) => messages.push(message),
        };
        const run = (button: ScriptElement) => new Script(WEBVIEW_SCRIPT).runInNewContext({
            acquireVsCodeApi: () => api,
            document: {
                querySelectorAll: (selector: string): ScriptElement[] => selector === '[data-action]' ? [button] : [],
            },
            window: {
                addEventListener: () => undefined,
                clearTimeout,
                setTimeout,
            },
        });

        const firstButton = createScriptElement({
            'data-action': 'restart',
            'data-service-id': 'service-1',
        }, '<svg>restart</svg>重启');
        run(firstButton);
        firstButton.fire('click', { target: firstButton });

        const rebuiltButton = createScriptElement({
            'data-action': 'restart',
            'data-service-id': 'service-1',
        }, '<svg>restart</svg>重启');
        run(rebuiltButton);
        expect(rebuiltButton.innerHTML).toBe('确认?');
        expect(rebuiltButton.classList.contains('is-confirming')).toBe(true);

        rebuiltButton.fire('click', { target: rebuiltButton });

        expect(messages).toEqual([{ command: 'restart', serviceId: 'service-1', requestId: '1' }]);
    });
});

function syncedContainer(
    serviceId: string,
    status: string,
    remote: boolean,
    expiresAt?: string,
    error?: SyncedContainer['error'],
    usage?: Pick<SyncedContainer, 'cpuUsage' | 'memoryUsage'>,
    extras: Partial<SyncedContainer> = {},
): SyncedContainer {
    return {
        serviceId,
        host: `host-${serviceId}`,
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
    innerHTML: string;
    addEventListener(type: string, listener: (event: { target: ScriptElement }) => void): void;
    classList: {
        add(value: string): void;
        contains(value: string): boolean;
        remove(value: string): void;
    };
    fire(type: string, event: { target: ScriptElement }): void;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    removeAttribute(name: string): void;
    setAttribute(name: string, value: string): void;
}

function createScriptElement(initialAttributes: Record<string, string>, innerHTML = ''): ScriptElement {
    const attributes = new Map(Object.entries(initialAttributes));
    const classes = new Set<string>();
    const listeners = new Map<string, (event: { target: ScriptElement }) => void>();
    return {
        innerHTML,
        classList: {
            add: value => classes.add(value),
            contains: value => classes.has(value),
            remove: value => classes.delete(value),
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
    const publicApi = options.publicApi ?? createPublicApi(userApi);
    return new SidebarViewProvider({
        state,
        sync: options.sync ?? { refresh: vi.fn(async () => ({ containers: [], changed: false })) },
        config: options.config ?? createConfig(),
        publicApi,
        userIdProvider: options.userIdProvider ?? { getCurrentUserId: vi.fn(async () => 'user-1') },
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
    });
}

interface ProviderTestOptions {
    state: SidebarSyncState;
    sync: {
        refresh: () => Promise<ContainerSyncResult>;
        start?: () => void;
        stop?: () => void;
        refreshAfterMutation?: () => Promise<ContainerSyncResult>;
        runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
        reconcileContainerOperation?: (operation: import('../src/containerOperations').ContainerOperationState) => Promise<boolean>;
        markContainerDeleted?: (serviceId: string) => void;
        clearContainerDeleted?: (serviceId: string) => void;
    };
    config: ContainerConfig;
    publicApi: PublicUserContainerApi;
    userIdProvider: { getCurrentUserId: () => Promise<string> };
    userApi: UserRestApi;
    getSettings: () => ReturnType<typeof settings>;
    cloudMode: boolean;
    getCloudMode: () => boolean;
    isDisconnected: () => boolean;
    onOpenConfig: () => void | Promise<void>;
    onOpenAdmin: () => void | Promise<void>;
    onConnect: (host: string, giteeRepository?: string) => void | Promise<void | boolean>;
    onDisconnect: () => void | Promise<void>;
    operationRegistry?: ContainerOperationRegistry;
    showInputBox: (options: import('vscode').InputBoxOptions) => Thenable<string | undefined>;
    view: ReturnType<typeof createWebviewView>;
}

function createUserApi(admin: boolean): UserRestApi {
    return {
        createContainer: vi.fn(async () => ({
            container_id: 'physical-service-1',
            service_id: 'service-1',
            status: 'pending',
        } as never)),
        getServiceIds: vi.fn(async () => ({ service_ids: [] })),
        getContainerStatuses: vi.fn(async () => ({ containers: [] })),
        getContainer: vi.fn(async () => ({
            service_id: 'service-1',
            status: 'running',
            gitee_user: '',
            gitee_repository: '',
        })),
        checkAdmin: vi.fn(async () => ({ admin, limit: admin ? 'none' as const : 'user' as const })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
}

function createPublicApi(userApi?: UserRestApi): PublicUserContainerApi {
    return {
        createContainer: vi.fn(async () => ({ service_id: 'service-1', status: 'pending' })),
        getContainer: vi.fn(async () => ({
            service_id: 'service-1',
            status: 'running',
            gitee_user: '',
            gitee_repository: '',
        })),
        checkAdmin: vi.fn(async () => userApi
            ? userApi.checkAdmin({ user_id: 'user-1' })
            : ({ admin: false, limit: 'user' as const })),
        getActiveServiceIds: vi.fn(async () => ({ service_ids: [] })),
        syncFiles: vi.fn(async () => ({
            direction: 'upload' as const,
            copied: 0,
            skipped: 0,
            deleted: 0,
            bytesTransferred: 0,
            complete: true,
        })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
}

function createConfig(entries: ContainerConfigEntry[] = []): ContainerConfig {
    const document = { config: {}, originalText: '' };
    return {
        read: vi.fn(async () => document),
        list: vi.fn(() => entries),
        removeContainer: vi.fn(() => true),
        upsertContainer: vi.fn(() => true),
        write: vi.fn(async () => true),
    } as unknown as ContainerConfig;
}

function configuredContainer(
    serviceId: string,
    host = `host-${serviceId}`,
    hostName = '127.0.0.1',
    port = 22,
): ContainerConfigEntry {
    return { serviceId, host, hostName, port };
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
