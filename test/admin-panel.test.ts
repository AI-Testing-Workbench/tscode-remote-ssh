import { Script } from 'node:vm';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { AdminPanel } from '../src/adminPanel';
import { ADMIN_WEBVIEW_SCRIPT } from '../src/adminWebview/script';
import { renderAdminPage } from '../src/adminWebview/view';
import type { AdminPanelState } from '../src/adminWebview/types';
import { REST_ERROR_CODES, RestClientError, type AdminRestApi, type UserRestApi } from '../src/api/restClient';
import * as vscode from './mocks/vscode';
import { ContainerOperationRegistry } from '../src/containerOperations';

const activePanels: AdminPanel[] = [];

describe('AdminPanel', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
        vscode.window.createWebviewPanel.mockReset();
        vscode.window.showOpenDialog.mockReset();
        vscode.window.showWarningMessage.mockReset();
        vscode.window.showErrorMessage.mockReset();
        vscode.window.showInformationMessage.mockReset();
    });

    afterEach(() => {
        activePanels.splice(0).forEach(panel => panel.dispose());
        vi.useRealTimers();
    });

    it('opens one secured panel and reloads all administrator datasets after a fresh check', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const userApi = createUserApi(true);
        const adminApi = createAdminApi();
        const userApiFactory = vi.fn(() => userApi);
        const adminApiFactory = vi.fn(() => adminApi);
        const adminPanel = createPanel({ userApiFactory, adminApiFactory });

        await adminPanel.open();
        await adminPanel.open();

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
        expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active);
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'testagentRemote.adminPanel',
            '管理员页面',
            vscode.ViewColumn.Active,
            expect.objectContaining({
                enableScripts: true,
                enableForms: false,
                localResourceRoots: [],
                retainContextWhenHidden: true,
            }),
        );
        expect(userApi.checkAdmin).toHaveBeenCalledWith({ user_id: 'admin-1' });
        expect(adminApiFactory).toHaveBeenCalledWith('https://api.example.test', 'admin-1');
        expect(adminApiFactory).toHaveBeenCalledOnce();
        expect(adminApi.listImages).toHaveBeenCalledOnce();
        expect(adminApi.getDefaultImage).toHaveBeenCalledOnce();
        expect(adminApi.listContainers).toHaveBeenCalledOnce();
        expect(adminApi.listOrphanContainers).toHaveBeenCalledOnce();
        expect(adminApi.getState).toHaveBeenCalledOnce();
        expect(adminApi.getContainerLimit).toHaveBeenCalledOnce();
        expect(adminApi.listWhitelistUsers).toHaveBeenCalledOnce();
        expect(adminApi.listAdminUsers).toHaveBeenCalledOnce();
        expect(panel.webview.options).toMatchObject({});
        expect(panel.webview.html).toContain('<h1>管理员页面</h1>');
        expect(panel.webview.html).not.toContain('管理员控制台');
        expect(panel.webview.html).toContain('镜像管理');
        expect(panel.webview.html).toContain('容器管理');
        expect(panel.webview.html).toContain('白名单用户');
        expect(panel.webview.html).toContain('管理员用户');
        expect(panel.webview.html).toContain('data-default-sort');
        expect(panel.webview.html).toContain('data-sort-toggle');
        expect(panel.webview.html).toContain('data-status-filter');
        expect(panel.webview.html).toContain('data-page-size');
        expect(panel.webview.html).toContain('default-banner');
        expect(panel.webview.html).toContain('stats-grid');
        expect(panel.webview.html).toContain('limit-card');
        expect(panel.webview.html).toContain('search-icon');
        expect(panel.webview.html).not.toContain('scope-label');
        expect(panel.webview.html).toContain('script-src \'nonce-');
        expect(panel.webview.html).not.toContain('主题切换');
    });

    it('shows an access error and never creates or calls an administrator API for a non-admin', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminApiFactory = vi.fn(() => adminApi);
        const adminPanel = createPanel({
            userApiFactory: vi.fn(() => createUserApi(false)),
            adminApiFactory,
        });

        await adminPanel.open();
        panel.fireMessage({ command: 'deleteAdminUser', userId: 'victim' });
        await flushMessages();

        expect(panel.webview.html).toContain('无权访问管理员页面');
        expect(adminApiFactory).not.toHaveBeenCalled();
        expect(adminApi.listImages).not.toHaveBeenCalled();
        expect(adminApi.deleteAdminUser).not.toHaveBeenCalled();
    });

    it('shows the backend error below the error summary', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        adminApi.startContainer = vi.fn(async () => {
            throw new RestClientError('http', 'container_not_ready', '容器当前不可启动', 409);
        });
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        panel.fireMessage({ command: 'containerAction', containerId: 'container-1', action: 'start' });
        await flushMessages();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            '后端 TestAgent Cloud 服务请求失败\n返回错误：容器当前不可启动（错误码：container_not_ready，HTTP 409）',
        );
    });

    it('does not restart a failed container', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        adminApi.listContainers = vi.fn(async () => ({ containers: [{ ...sampleContainer(), status: 'failed' }] }));
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        panel.fireMessage({ command: 'containerAction', containerId: 'container-1', action: 'restart' });
        await flushMessages();

        expect(adminApi.restartContainer).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('服务 "container-1" 处于失败状态，不能重启');
    });

    it('keeps a timed-out administrator lifecycle operation in reconciliation', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        adminApi.stopContainer = vi.fn(async () => {
            throw new RestClientError('network', REST_ERROR_CODES.TIMEOUT, '停止 TestAgent Cloud 服务超时');
        });
        const operationRegistry = new ContainerOperationRegistry();
        const reconcile = vi.fn(async () => false);
        const adminPanel = createPanel({
            adminApiFactory: vi.fn(() => adminApi),
            operationRegistry,
            onContainerOperation: reconcile,
        });

        await adminPanel.open();
        await send(panel, { command: 'selectTab', tab: 'containers' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'stop' });

        expect(adminApi.stopContainer).toHaveBeenCalledWith('container-1');
        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            containerId: 'container-1',
            action: 'stop',
            phase: 'reconciling',
        }));
        expect(operationRegistry.get('container-1')).toMatchObject({ action: 'stop', phase: 'reconciling' });
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('1 分钟'));
        expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'adminUpdate',
            html: expect.stringContaining('停止中'),
        }));
        expect(vscode.window.withProgress).toHaveBeenCalledWith(expect.objectContaining({
            title: '正在停止 TestAgent Cloud 服务',
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
        }), expect.any(Function));
    });

    it('shows restore progress and keeps a deleted service in a restoring transition', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        vi.mocked(adminApi.listContainers).mockResolvedValue({ containers: [{
            ...sampleContainer(),
            status: 'business_deleted',
            business_deleted: true,
            deleted_at: '2026-09-05T01:02:03Z',
        }] });
        const operationRegistry = new ContainerOperationRegistry();
        const reconcile = vi.fn(async () => false);
        const adminPanel = createPanel({
            adminApiFactory: vi.fn(() => adminApi),
            operationRegistry,
            onContainerOperation: reconcile,
        });

        await adminPanel.open();
        await send(panel, { command: 'selectTab', tab: 'containers' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'restore', expirationHours: '24' });

        expect(adminApi.restoreContainer).toHaveBeenCalledWith('container-1', { expiration_hours: 24 });
        expect(operationRegistry.get('container-1')).toMatchObject({ action: 'restore', phase: 'reconciling' });
        expect(vscode.window.withProgress).toHaveBeenCalledWith(expect.objectContaining({
            title: '正在恢复 TestAgent Cloud 服务',
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
        }), expect.any(Function));
        expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'adminUpdate',
            html: expect.stringContaining('恢复中'),
        }));
    });

    it('switches tabs and scopes search to the active resource dataset', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        await send(panel, { command: 'selectTab', tab: 'containers' });
        expect(panel.webview.html).toContain('全局资源限制');
        expect(panel.webview.html).toContain('data-search-input');
        expect(panel.webview.html).not.toContain('IMAGES</p>');

        await send(panel, { command: 'search', value: 'user-1' });
        expect(panel.webview.html).toContain('value="user-1"');
    });

    it('renders the compact overview, missing-image marker, collapsible forms, and container terminology', () => {
        const state: AdminPanelState = {
            status: 'ready',
            activeTab: 'containers',
            search: '',
            images: [],
            defaultImage: 'registry.test:5000/testagent/missing:v1',
            containers: [],
            orphanContainerIds: ['orphan-1', 'orphan-2'],
            stats: {
                container_count: 3,
                whitelist_container_count: 2,
                admin_container_count: 1,
                whitelist_count: 4,
                admin_count: 2,
            },
            limit: { container_limit: 4, cpu: 2, memory: 4 },
            whitelistUsers: [],
            adminUsers: [],
        };

        const html = renderAdminPage(state, 'nonce', 'vscode-resource://test');

        expect(html.indexOf('<div class="stats-grid service-stats">')).toBeLessThan(html.indexOf('<div class="stats-grid people-stats">'));
        expect(html.indexOf('服务总数')).toBeLessThan(html.indexOf('孤儿容器'));
        expect(html.indexOf('孤儿容器')).toBeLessThan(html.indexOf('白名单服务'));
        expect(html.indexOf('<div class="stats-grid people-stats">')).toBeLessThan(html.indexOf('default-banner overview-card'));
        expect(html).toContain('镜像不存在');
        expect(html).toContain('3/4');
        expect(html).toContain('孤儿容器');
        expect(html).toContain('data-action="deleteOrphanContainers"');
        expect(html).toContain('default-image-line');
        expect(html).toContain('data-custom-select');
        expect(html).toContain('@keyframes panel-enter');
        expect(html).toContain('prefers-reduced-motion: reduce');
        expect(html).toContain('CPU（当前值：2 核）');
        expect(html).toContain('内存（当前值：4 Gi）');
        expect(html).not.toContain('当前使用');
        expect(html).not.toContain('default-separator');
        expect(html).not.toContain('status-dot');
        expect(html).not.toContain('resource-symbol');
        expect(html).not.toContain('search-clear');
        expect(html).toContain('容器管理');
        expect(html).not.toContain('SERVICES');
        expect(html).not.toContain('服务管理');
        expect(html).toContain('value="none" type="radio" checked>不填写码云信息');
        expect(html).toContain('data-gitee-mode-panel="full"');
        expect(html).toContain('data-gitee-mode-panel="parts"');
        expect(html).toContain('data-field="gitee_repository" data-persist-key="create.gitee_repository" type="text" placeholder="仓库名" disabled');
        expect(html).toContain('data-resource-items');
        expect(html).not.toContain('data-action="clearSearch"');
        expectPersistedFields(html, [
            'limit.container_limit',
            'limit.cpu',
            'limit.memory',
            'create.user_id',
            'create.giteeMode',
            'create.giteeMode',
            'create.giteeMode',
            'create.gitee_full_url',
            'create.gitee_user',
            'create.gitee_repository',
            'create.gitee_url',
            'create.gitee_branch',
            'create.authorize_general_account',
            'create.image',
            'create.expiration_hours',
            'create.cpu',
            'create.memory',
        ]);

        const noDefaultHtml = renderAdminPage({ ...state, defaultImage: null }, 'nonce', 'vscode-resource://test');
        expect(noDefaultHtml).toContain('default-banner overview-card danger');
        expect(noDefaultHtml).toContain('danger-tag">未配置');
        expect(noDefaultHtml).toContain('.default-banner.danger { border-color: var(--danger);');

        const failedHtml = renderAdminPage({
            ...state,
            containers: [{ ...sampleContainer(), status: 'failed' }],
        }, 'nonce', 'vscode-resource://test');
        expect(failedHtml).toContain('value="failed"');
        expect(failedHtml).toContain('data-filter-status="failed"');
        expect(failedHtml).toContain('status-chip tag warning">失败</span>');
        const stoppedHtml = renderAdminPage({
            ...state,
            containers: [{ ...sampleContainer(), status: 'stopped' }],
        }, 'nonce', 'vscode-resource://test');
        for (const action of ['start', 'stop']) {
            expect(getContainerActionButton(failedHtml, action)).toBe(getContainerActionButton(stoppedHtml, action));
        }
        expect(getContainerActionButton(failedHtml, 'restart')).toMatch(/disabled>/);
        expect(getContainerActionButton(stoppedHtml, 'restart')).not.toMatch(/disabled>/);

        const containerHtml = renderAdminPage({
            ...state,
            containers: [sampleContainer()],
        }, 'nonce', 'vscode-resource://test');
        expect(containerHtml).toContain('status-border-success');
        expect(containerHtml).toContain('data-select-menu');
        expect(containerHtml).toContain('码云用户/仓库名 (分支)');
        expect(containerHtml).toContain('alice/repo (main)');
        expect(containerHtml).toContain('授权通用账户');
        expect(containerHtml).toContain('否');
        expect(containerHtml).toContain('2026/09/04 08:00');
        expect(containerHtml).toContain('预计删除时间');
        expect(containerHtml).toContain('2026/09/05 08:00');
        expect(containerHtml).toContain('detail-item usage-metric-low');
        const containerRowStart = containerHtml.indexOf('<article class="resource-row container-row');
        expect(containerRowStart).toBeGreaterThanOrEqual(0);
        const containerRowEnd = containerHtml.indexOf('</article>', containerRowStart);
        expect(containerRowEnd).toBeGreaterThan(containerRowStart);
        expect(containerHtml.slice(containerRowStart, containerRowEnd)).not.toContain('创建时间');
        expect(containerHtml).toContain('container-operation-row');
        expect(containerHtml).toContain('container-expiration-row');
        expect(containerHtml).toContain('.container-expiration-row { padding-top: 0; }');
        const operationRow = containerHtml.indexOf('<div class="container-operation-row"', containerRowStart);
        const expirationRow = containerHtml.indexOf('<div class="container-expiration-row"', containerRowStart);
        expect(operationRow).toBeGreaterThan(containerRowStart);
        expect(expirationRow).toBeGreaterThan(operationRow);
        expect(containerHtml).toContain('</div>\n            <button class="small-button log-button"');
        expect(containerHtml).toContain('.branch-row { width: 100%;');

        const deletedHtml = renderAdminPage({
            ...state,
            containers: [{
                ...sampleContainer(),
                status: 'stopped',
                business_deleted: true,
                deleted_at: '2026-09-05T01:02:03Z',
            }],
        }, 'nonce', 'vscode-resource://test');
        expect(deletedHtml).toContain('status-border-error deleted-row');
        expect(deletedHtml).toContain('删除时间');
        expect(deletedHtml).toContain('2026/09/05 09:02');
        expect(deletedHtml).not.toContain('预计删除时间');

        const userHtml = renderAdminPage({ ...state, activeTab: 'whitelist', whitelistUsers: ['user-1'] }, 'nonce', 'vscode-resource://test');
        expect(userHtml).toContain('<details class="inline-form user-form collapsible-card" data-form="whitelistUser" open>');
        expectPersistedFields(userHtml, [
            'limit.container_limit',
            'limit.cpu',
            'limit.memory',
            'whitelist.user_id',
        ]);

        const imageHtml = renderAdminPage({
            ...state,
            activeTab: 'images',
            images: [{
                id: 'image-1',
                full_name: 'registry.test:5000/testagent/app:v1',
                registry: 'registry.test:5000',
                namespace: 'testagent',
                name: 'app',
                version: 'v1',
                created_at: '2026-09-04T00:00:00Z',
                size: 1024,
                status: 'pushed',
            }],
        }, 'nonce', 'vscode-resource://test');
        expectPersistedFields(imageHtml, [
            'limit.container_limit',
            'limit.cpu',
            'limit.memory',
            'upload.registry',
            'upload.namespace',
            'upload.autoPush',
            'image.registry.test:5000/testagent/app:v1.alsoRegistry',
        ]);
        const deleteImageButton = imageHtml.indexOf('data-action="deleteImage"');
        const registryCheckbox = imageHtml.indexOf('>同步注册表</label>');
        expect(deleteImageButton).toBeGreaterThanOrEqual(0);
        expect(registryCheckbox).toBeGreaterThan(deleteImageButton);
        expect(imageHtml).not.toContain('image-usage');

        const defaultImageHtml = renderAdminPage({
            ...state,
            activeTab: 'images',
            defaultImage: 'registry.test:5000/testagent/app:v1',
            images: [{
                id: 'image-1',
                full_name: 'registry.test:5000/testagent/app:v1',
                registry: 'registry.test:5000',
                namespace: 'testagent',
                name: 'app',
                version: 'v1',
                created_at: '2026-09-04T00:00:00Z',
                size: 1024,
                status: 'pushed',
            }],
        }, 'nonce', 'vscode-resource://test');
        expect(defaultImageHtml).toMatch(/<label class="row-check check-button disabled"><input[^>]*disabled[^>]*>同步注册表<\/label>/);

        const imageWithUsageHtml = renderAdminPage({
            ...state,
            activeTab: 'images',
            containers: [
                sampleContainer(),
                { ...sampleContainer(), container_id: 'container-deleted', status: 'business_deleted', business_deleted: true },
            ],
            images: [{
                id: 'image-1',
                full_name: 'registry.test:5000/testagent/app:v1',
                registry: 'registry.test:5000',
                namespace: 'testagent',
                name: 'app',
                version: 'v1',
                created_at: '2026-09-04T00:00:00Z',
                size: 1024,
                status: 'pushed',
            }],
        }, 'nonce', 'vscode-resource://test');
        expect(imageWithUsageHtml).toContain('2 个容器使用中');
    });

    it('defaults administrator container creation to no Gitee information', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        await send(panel, {
            command: 'createContainer',
            user_id: 'user-5',
            giteeMode: 'none',
            gitee_full_url: 'https://gitee.com/ignored/repository',
            gitee_user: 'ignored',
            gitee_repository: 'ignored',
            gitee_url: 'https://gitee.com',
        });

        expect(adminApi.createContainer).toHaveBeenCalledWith({
            user_id: 'user-5',
            authorize_general_account: false,
        });
    });

    it('renders the selected image filename after choosing an image file', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminPanel = createPanel({
            showOpenDialog: vi.fn(async () => [{ fsPath: 'C:\\tmp\\release.tar.gz' } as never]),
        });

        await adminPanel.open();
        expect(panel.webview.html).toContain('尚未选择镜像文件');

        await send(panel, { command: 'selectImageFile' });

        expect(panel.webview.html).toContain('release.tar.gz');
        expect(panel.webview.postMessage).toHaveBeenCalledWith({ command: 'imageFileSelected', filename: 'release.tar.gz' });
    });

    it('shows only the empty-list message when a user dataset has no rows', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        vi.mocked(adminApi.listWhitelistUsers).mockResolvedValue({ user_ids: [] });
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        await send(panel, { command: 'selectTab', tab: 'whitelist' });

        expect(panel.webview.html).toContain('暂无用户');
        expect(panel.webview.html).not.toContain('没有匹配的用户');
    });

    it('rejects incomplete values in the separate Gitee input mode', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        await send(panel, {
            command: 'createContainer',
            user_id: 'user-2',
            giteeMode: 'parts',
            gitee_user: 'alice',
            gitee_repository: 'repo',
        });

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('分别填写模式需要完整填写码云用户名、仓库名和网址前缀');
        expect(adminApi.createContainer).not.toHaveBeenCalled();
    });

    it('renders a page error when the current user ID is unavailable', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const userApiFactory = vi.fn(() => createUserApi(true));
        const adminApiFactory = vi.fn(() => createAdminApi());
        const adminPanel = createPanel({
            userIdProvider: { getCurrentUserId: vi.fn(async () => '') },
            userApiFactory,
            adminApiFactory,
        });

        await adminPanel.open();

        expect(panel.webview.html).toContain('管理员页面加载失败');
        expect(panel.webview.html).toContain('未获取到当前用户 ID');
        expect(userApiFactory).not.toHaveBeenCalled();
        expect(adminApiFactory).not.toHaveBeenCalled();
    });

    it('refreshes on the configured status interval and stops after disposal', async () => {
        vi.useFakeTimers();
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const getSettings = vi.fn(() => ({
            backendApiUrl: 'https://api.example.test',
            userName: 'root',
            skipKnownHostsCheck: true,
            historyLimit: 5,
            statusSyncInterval: 1,
            debug: false,
            disableClientValidation: true,
        }));
        const adminPanel = createPanel({ getSettings, adminApiFactory: vi.fn(() => adminApi) });

        await adminPanel.open();
        panel.fireMessage({ command: 'ready' });
        await Promise.resolve();
        await Promise.resolve();
        const requestsBeforeTimer = vi.mocked(adminApi.listContainers).mock.calls.length;
        const htmlBeforeTimer = panel.webview.html;
        vi.mocked(adminApi.getDefaultImage).mockResolvedValueOnce({ full_name: null });
        await vi.advanceTimersByTimeAsync(1000);
        const requestsAfterTimer = vi.mocked(adminApi.listContainers).mock.calls.length;
        expect(panel.webview.html).toBe(htmlBeforeTimer);
        expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'adminUpdate',
            html: expect.stringContaining('class="stat-card default-banner overview-card danger"'),
        }));
        adminPanel.dispose();
        await vi.advanceTimersByTimeAsync(2000);

        expect(getSettings).toHaveBeenCalled();
        expect(requestsAfterTimer).toBeGreaterThan(requestsBeforeTimer);
        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBe(requestsAfterTimer);
    });

    it('pauses automatic refresh while the log modal is open and resumes after it closes', async () => {
        vi.useFakeTimers();
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({
            getSettings: () => ({
                backendApiUrl: 'https://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: true,
                historyLimit: 5,
                statusSyncInterval: 1,
                debug: false,
                disableClientValidation: true,
            }),
            adminApiFactory: vi.fn(() => adminApi),
        });

        await adminPanel.open();
        const requestsBeforePause = vi.mocked(adminApi.listContainers).mock.calls.length;
        const htmlBeforePause = panel.webview.html;
        panel.fireMessage({ command: 'setLogOpen', open: true });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2000);

        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBe(requestsBeforePause);
        expect(panel.webview.html).toBe(htmlBeforePause);

        panel.fireMessage({ command: 'setLogOpen', open: false });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1000);

        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBeGreaterThan(requestsBeforePause);
    });

    it('pauses automatic refresh while a custom select is open and resumes after it closes', async () => {
        vi.useFakeTimers();
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({
            getSettings: () => ({
                backendApiUrl: 'https://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: true,
                historyLimit: 5,
                statusSyncInterval: 1,
                debug: false,
                disableClientValidation: true,
            }),
            adminApiFactory: vi.fn(() => adminApi),
        });

        await adminPanel.open();
        const requestsBeforePause = vi.mocked(adminApi.listContainers).mock.calls.length;
        const htmlBeforePause = panel.webview.html;
        panel.fireMessage({ command: 'setSelectOpen', open: true });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2000);

        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBe(requestsBeforePause);
        expect(panel.webview.html).toBe(htmlBeforePause);

        panel.fireMessage({ command: 'setSelectOpen', open: false });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1000);

        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBeGreaterThan(requestsBeforePause);
    });

    it('routes image, container, limit, whitelist, and administrator operations through the checked API', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const userApi = createUserApi(true);
        const adminPanel = createPanel({
            userApiFactory: vi.fn(() => userApi),
            adminApiFactory: vi.fn(() => adminApi),
            showOpenDialog: vi.fn(async () => [{ fsPath: 'C:\\tmp\\release.tar.gz' } as never]),
        });
        vscode.window.showWarningMessage.mockImplementation(async (_message, _options, ...items) => items[0]);

        await adminPanel.open();
        await send(panel, { command: 'getContainerLog', containerId: 'container-1' });
        await send(panel, { command: 'deleteOrphanContainers', orphanContainerIds: 'orphan-1,orphan-2' });
        await send(panel, { command: 'uploadImage', registry: 'registry.test:5000', namespace: 'testagent', autoPush: false });
        await send(panel, { command: 'pushImage', fullName: 'registry.test:5000/testagent/app:v1' });
        await send(panel, { command: 'setDefaultImage', fullName: 'registry.test:5000/testagent/app:v1' });
        await send(panel, { command: 'unsetDefaultImage' });
        await send(panel, { command: 'deleteImage', fullName: 'registry.test:5000/testagent/app:v1', alsoRegistry: false });
        await send(panel, {
            command: 'createContainer',
            user_id: 'user-2',
            giteeMode: 'parts',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            image: 'registry.test:5000/testagent/app:v1',
            authorize_general_account: true,
            expiration_hours: '2',
            cpu: '1.5',
            memory: '2',
        });
        await send(panel, {
            command: 'createContainer',
            user_id: 'user-4',
            giteeMode: 'full',
            gitee_full_url: 'https://gitee.com/alice/repo/tree/main?tab=readme',
        });
        await send(panel, { command: 'setLimit', container_limit: '4', cpu: '2', memory: '4' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'start' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'expiration', expirationHours: '3' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'restore', expirationHours: '5' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'delete' });
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'permanent-delete' });
        await send(panel, { command: 'addWhitelistUser', user_id: 'user-3' });
        await send(panel, { command: 'deleteWhitelistUser', userId: 'user-3' });
        await send(panel, { command: 'addAdminUser', user_id: 'admin-2' });
        await send(panel, { command: 'deleteAdminUser', userId: 'admin-2' });

        expect(adminApi.uploadImage).toHaveBeenCalledWith(expect.objectContaining({
            filePath: 'C:\\tmp\\release.tar.gz',
            filename: 'release.tar.gz',
            registry: 'registry.test:5000',
            namespace: 'testagent',
            auto_push: false,
        }));
        expect(adminApi.getContainerLog).toHaveBeenCalledWith('container-1');
        expect(adminApi.deleteOrphanContainers).toHaveBeenCalledWith({ container_ids: ['orphan-1', 'orphan-2'] });
        expect(adminApi.pushImage).toHaveBeenCalledWith({ full_name: 'registry.test:5000/testagent/app:v1' });
        expect(adminApi.setDefaultImage).toHaveBeenCalledWith({ full_name: 'registry.test:5000/testagent/app:v1' });
        expect(adminApi.unsetDefaultImage).toHaveBeenCalledOnce();
        expect(adminApi.deleteImage).toHaveBeenCalledWith({
            full_name: 'registry.test:5000/testagent/app:v1',
            also_registry: false,
        });
        expect(adminApi.createContainer).toHaveBeenCalledWith({
            user_id: 'user-2',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            image: 'registry.test:5000/testagent/app:v1',
            authorize_general_account: true,
            expiration_hours: 2,
            cpu: 1.5,
            memory: 2,
        });
        expect(adminApi.createContainer).toHaveBeenLastCalledWith({
            user_id: 'user-4',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_url: 'https://gitee.com',
            authorize_general_account: false,
        });
        expect(adminApi.setContainerLimit).toHaveBeenCalledWith({ container_limit: 4, cpu: 2, memory: 4 });
        expect(adminApi.startContainer).toHaveBeenCalledWith('container-1');
        expect(adminApi.setExpiration).toHaveBeenCalledWith('container-1', { expiration_hours: 3 });
        expect(adminApi.restoreContainer).toHaveBeenCalledWith('container-1', { expiration_hours: 5 });
        expect(adminApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(adminApi.permanentDeleteContainer).toHaveBeenCalledWith('container-1');
        expect(adminApi.addWhitelistUser).toHaveBeenCalledWith({ user_id: 'user-3' });
        expect(adminApi.deleteWhitelistUser).toHaveBeenCalledWith({ user_id: 'user-3' });
        expect(adminApi.addAdminUser).toHaveBeenCalledWith({ user_id: 'admin-2' });
        expect(adminApi.deleteAdminUser).toHaveBeenCalledWith({ user_id: 'admin-2' });
        expect(userApi.checkAdmin).toHaveBeenCalledTimes(38);
    });

    it('does not execute or refresh destructive actions when confirmation is dismissed', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const adminApi = createAdminApi();
        const adminPanel = createPanel({ adminApiFactory: vi.fn(() => adminApi) });
        vscode.window.showWarningMessage.mockResolvedValue(undefined);

        await adminPanel.open();
        const requestsBeforeAction = vi.mocked(adminApi.listContainers).mock.calls.length;

        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'delete' });

        expect(adminApi.deleteContainer).not.toHaveBeenCalled();
        expect(vi.mocked(adminApi.listContainers).mock.calls.length).toBe(requestsBeforeAction);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            '确定对服务「container-1」执行业务删除吗？',
            { modal: true },
            '业务删除',
        );
    });

    it('rechecks administrator access before each operation', async () => {
        const panel = createWebviewPanel();
        vscode.window.createWebviewPanel.mockReturnValue(panel as never);
        const userApi = createUserApi(true);
        vi.mocked(userApi.checkAdmin)
            .mockResolvedValueOnce({ admin: true })
            .mockResolvedValueOnce({ admin: false });
        const adminApi = createAdminApi();
        const adminPanel = createPanel({
            userApiFactory: vi.fn(() => userApi),
            adminApiFactory: vi.fn(() => adminApi),
        });

        await adminPanel.open();
        await send(panel, { command: 'containerAction', containerId: 'container-1', action: 'start' });

        expect(userApi.checkAdmin).toHaveBeenCalledTimes(2);
        expect(adminApi.startContainer).not.toHaveBeenCalled();
        expect(panel.webview.html).toContain('无权访问管理员页面');
    });

    it('releases the panel and can create a fresh singleton after closing', async () => {
        const firstPanel = createWebviewPanel();
        const secondPanel = createWebviewPanel();
        vscode.window.createWebviewPanel
            .mockReturnValueOnce(firstPanel as never)
            .mockReturnValueOnce(secondPanel as never);
        const adminPanel = createPanel();

        await adminPanel.open();
        firstPanel.dispose();
        await adminPanel.open();

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
        expect(firstPanel.reveal).not.toHaveBeenCalled();
        expect(secondPanel.webview.html).toContain('镜像管理');
    });

    it('keeps the webview script valid and the page free of direct REST calls or theme controls', () => {
        expect(() => new Script(ADMIN_WEBVIEW_SCRIPT)).not.toThrow();
        expect(ADMIN_WEBVIEW_SCRIPT).not.toContain('fetch(');
        expect(ADMIN_WEBVIEW_SCRIPT).not.toContain('http://');
        expect(ADMIN_WEBVIEW_SCRIPT).not.toContain('主题');
    });
});

function createPanel(options: Partial<ConstructorParameters<typeof AdminPanel>[0]> = {}): AdminPanel {
    const panel = new AdminPanel({
        userIdProvider: { getCurrentUserId: vi.fn(async () => 'admin-1') },
        getSettings: () => ({
            backendApiUrl: 'https://api.example.test',
            userName: 'root',
            skipKnownHostsCheck: true,
            historyLimit: 5,
            statusSyncInterval: 5,
            debug: false,
            disableClientValidation: true,
        }),
        userApiFactory: () => createUserApi(true),
        adminApiFactory: () => createAdminApi(),
        ...options,
    });
    activePanels.push(panel);
    return panel;
}

function createUserApi(admin: boolean): UserRestApi {
    return {
        createContainer: vi.fn(),
        getContainerIds: vi.fn(),
        getContainer: vi.fn(),
        checkAdmin: vi.fn(async () => ({ admin })),
        startContainer: vi.fn(),
        stopContainer: vi.fn(),
        restartContainer: vi.fn(),
        deleteContainer: vi.fn(),
    };
}

function createAdminApi(): AdminRestApi {
    return {
        uploadImage: vi.fn(async () => undefined),
        pushImage: vi.fn(async () => undefined),
        listImages: vi.fn(async () => ({
            images: [{
                id: 'image-1',
                full_name: 'registry.test:5000/testagent/app:v1',
                registry: 'registry.test:5000',
                namespace: 'testagent',
                name: 'app',
                version: 'v1',
                created_at: '2026-09-04T00:00:00Z',
                size: 1024,
                status: 'pushed',
            }],
        })),
        deleteImage: vi.fn(async () => undefined),
        getDefaultImage: vi.fn(async () => ({ full_name: 'registry.test:5000/testagent/app:v1' })),
        setDefaultImage: vi.fn(async () => undefined),
        unsetDefaultImage: vi.fn(async () => undefined),
            createContainer: vi.fn(async () => sampleContainer()),
            listContainers: vi.fn(async () => ({ containers: [sampleContainer()] })),
        listOrphanContainers: vi.fn(async () => ({ container_ids: ['orphan-1', 'orphan-2'] })),
            deleteOrphanContainers: vi.fn(async () => undefined),
            getContainer: vi.fn(async () => sampleContainer()),
        getContainerLog: vi.fn(async () => 'log'),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
        permanentDeleteContainer: vi.fn(async () => undefined),
        setExpiration: vi.fn(async () => ({ container_id: 'container-1', expires_at: '2026-09-05T00:00:00Z' })),
        restoreContainer: vi.fn(async () => undefined),
        getState: vi.fn(async () => ({
            container_count: 1,
            whitelist_container_count: 1,
            admin_container_count: 0,
            whitelist_count: 1,
            admin_count: 1,
        })),
        getContainerLimit: vi.fn(async () => ({ container_limit: 4, cpu: 2, memory: 4 })),
        setContainerLimit: vi.fn(async () => ({ container_limit: 4, cpu: 2, memory: 4 })),
        addWhitelistUser: vi.fn(async () => ({ user_id: 'user-3' })),
        listWhitelistUsers: vi.fn(async () => ({ user_ids: ['user-3'] })),
        deleteWhitelistUser: vi.fn(async () => undefined),
        addAdminUser: vi.fn(async () => ({ user_id: 'admin-2' })),
        listAdminUsers: vi.fn(async () => ({ user_ids: ['admin-2'] })),
        deleteAdminUser: vi.fn(async () => undefined),
    };
}

function sampleContainer() {
    return {
        container_id: 'container-1',
        status: 'running',
        endpoint: '10.0.0.1:22',
        started_at: '2026-09-04T00:00:00Z',
        expires_at: '2026-09-05T00:00:00Z',
        cpu_usage: 20,
        memory_usage: 30,
        image: 'registry.test:5000/testagent/app:v1',
        user_id: 'user-1',
        gitee_user: 'alice',
        gitee_repository: 'repo',
        gitee_branch: 'main',
        gitee_url: 'https://gitee.com',
        created_at: '2026-09-04T00:00:00Z',
        expiration_hours: 24,
        authorize_general_account: false,
        deleted_at: null,
        business_deleted: false,
    };
}

function getContainerActionButton(html: string, action: string): string {
    return html.match(new RegExp(`<button[^>]*data-container-action="${action}"[^>]*>[^<]*</button>`))?.[0] ?? '';
}

function createWebviewPanel() {
    const messages = createEvent<unknown>();
    const disposal = createEvent<void>();
    let disposed = false;
    const panel = {
        viewType: 'testagentRemote.adminPanel',
        title: 'TestAgent Cloud 管理员控制台',
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-webview-resource://test',
            onDidReceiveMessage: messages.event,
            postMessage: vi.fn(async () => true),
        },
        reveal: vi.fn(),
        onDidDispose: disposal.event,
        dispose: vi.fn(() => {
            if (!disposed) {
                disposed = true;
                disposal.fire(undefined);
            }
        }),
        fireMessage: (message: unknown) => messages.fire(message),
    };
    return panel;
}

function createEvent<T>() {
    let listener: ((value: T) => void) | undefined;
    return {
        event: (nextListener: (value: T) => void) => {
            listener = nextListener;
            return { dispose: vi.fn() };
        },
        fire: (value: T) => listener?.(value),
    };
}

async function send(panel: ReturnType<typeof createWebviewPanel>, message: unknown): Promise<void> {
    panel.fireMessage(message);
    await flushMessages();
}

async function flushMessages(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.resolve();
}

function expectPersistedFields(html: string, expectedKeys: string[]): void {
    const markup = html.split('<script')[0];
    const actualKeys = [...markup.matchAll(/data-field="[^"]+"\s+data-persist-key="([^"]+)"/g)]
        .map(match => match[1]);
    expect(actualKeys.sort()).toEqual([...expectedKeys].sort());
}
