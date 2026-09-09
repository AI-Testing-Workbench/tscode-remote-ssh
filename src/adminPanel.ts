import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Log } from './common/logger';
import {
    AdminCreateContainerRequest,
    ContainerLimitRequest,
    ContainerTypeValue,
    ExpirationRequest,
    ImageDeleteRequest,
    UploadImageFileInput,
} from './api/models';
import { AdminRestApi, formatRestClientError, RestClient, RestClientError, REST_ERROR_CODES, UserRestApi } from './api/restClient';
import {
    ContainerOperationAction,
    ContainerOperationEvent,
    ContainerOperationRegistry,
    ContainerOperationState,
    getContainerOperationName,
    getContainerOperationStatus,
    isContainerOperationAction,
} from './containerOperations';
import { getRemoteSettings, RemoteSettings } from './settings';
import { UserIdProvider } from './user';
import { parseGiteeRepositoryUrl as parseRepositoryUrl } from './giteeRepository';
import { renderAdminContent, renderAdminPage } from './adminWebview/view';
import { ADMIN_CONTAINER_TYPES, containerTypeOf } from './adminWebview/containerTypes';
import { AdminDefaultImage, AdminPanelState, AdminTab } from './adminWebview/types';

export const ADMIN_PANEL_VIEW_TYPE = 'testagentRemote.adminPanel';
export const ADMIN_PANEL_TITLE = '管理员页面';
const OPERATION_RECONCILIATION_TIMEOUT_MS = 60_000;

type UserIdSource = Pick<UserIdProvider, 'getCurrentUserId'>;
type PanelLogger = Pick<Log, 'error'>;
type ShowOpenDialog = (options?: vscode.OpenDialogOptions) => Thenable<vscode.Uri[] | undefined>;
type AdminApiFactory = (baseUrl: string, operatorUserId: string) => AdminRestApi;
type AdminData = Pick<AdminPanelState, 'images' | 'defaultImages' | 'containers' | 'orphanContainerIds' | 'stats' | 'limit' | 'whitelistUsers' | 'adminUsers'>;

export interface AdminPanelOptions {
    userIdProvider?: UserIdSource;
    getSettings?: () => RemoteSettings;
    userApiFactory?: (baseUrl: string) => UserRestApi;
    adminApiFactory?: AdminApiFactory;
    operationRegistry?: ContainerOperationRegistry;
    onContainerOperation?: (operation: ContainerOperationState) => Promise<boolean>;
    showOpenDialog?: ShowOpenDialog;
    logger?: PanelLogger;
}

export class AdminPanel implements vscode.Disposable {
    private readonly userIdProvider: UserIdSource;
    private readonly getSettings: () => RemoteSettings;
    private readonly userApiFactory: (baseUrl: string) => UserRestApi;
    private readonly adminApiFactory: AdminApiFactory;
    private readonly operationRegistry: ContainerOperationRegistry | undefined;
    private readonly onContainerOperation: ((operation: ContainerOperationState) => Promise<boolean>) | undefined;
    private readonly showOpenDialog: ShowOpenDialog;
    private readonly logger: PanelLogger | undefined;

    private panel: vscode.WebviewPanel | undefined;
    private selectedImageFile: { fsPath: string; filename: string } | undefined;
    private panelDisposables: vscode.Disposable[] = [];
    private readonly operationSubscription: { dispose: () => void };
    private readonly reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshPromise: Promise<void> | undefined;
    private loadPromise: Promise<void> | undefined;
    private messageQueue: Promise<void> = Promise.resolve();
    private operationInFlight = false;
    private operationGeneration: number | undefined;
    private logOpen = false;
    private selectOpen = false;
    private generation = 0;
    private webviewReady = false;
    private pendingAdminUpdate = false;
    private disposed = false;
    private state: AdminPanelState = createInitialState();

    constructor(options: AdminPanelOptions = {}) {
        this.userIdProvider = options.userIdProvider ?? new UserIdProvider();
        this.getSettings = options.getSettings ?? getRemoteSettings;
        this.userApiFactory = options.userApiFactory ?? ((baseUrl: string) => new RestClient(baseUrl).user);
        this.adminApiFactory = options.adminApiFactory ?? ((baseUrl: string, operatorUserId: string) => new RestClient(baseUrl, { operatorUserId }).admin);
        this.operationRegistry = options.operationRegistry;
        this.onContainerOperation = options.onContainerOperation;
        this.operationSubscription = this.operationRegistry?.subscribe(event => this.handleContainerOperationEvent(event)) ?? { dispose: () => undefined };
        this.logger = options.logger;
        this.showOpenDialog = options.showOpenDialog ?? (dialogOptions => vscode.window.showOpenDialog(dialogOptions));
    }

    public open(): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return this.loadPromise ?? Promise.resolve();
        }

        const panel = vscode.window.createWebviewPanel(
            ADMIN_PANEL_VIEW_TYPE,
            ADMIN_PANEL_TITLE,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                enableForms: false,
                localResourceRoots: [],
                retainContextWhenHidden: true,
            },
        );
        const generation = ++this.generation;
        this.panel = panel;
        this.state = createInitialState();
        this.logOpen = false;
        this.operationInFlight = false;
        this.operationGeneration = undefined;
        this.messageQueue = Promise.resolve();
        this.setPanelHtml(panel);

        const messageSubscription = panel.webview.onDidReceiveMessage(message => {
            this.enqueueMessage(panel, generation, message);
        });
        const disposeSubscription = panel.onDidDispose(() => {
            this.handlePanelDisposed(panel, generation);
        });
        this.panelDisposables = [messageSubscription, disposeSubscription];
        this.startRefreshTimer(panel, generation);

        const loadPromise = this.refresh(panel, generation);
        this.loadPromise = loadPromise.finally(() => {
            if (this.panel === panel && this.generation === generation) {
                this.loadPromise = undefined;
            }
        });
        return this.loadPromise;
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const panel = this.panel;
        this.panel = undefined;
        this.generation++;
        this.clearRefreshTimer();
        this.refreshPromise = undefined;
        this.loadPromise = undefined;
        this.logOpen = false;
        this.selectOpen = false;
        this.operationInFlight = false;
        this.operationGeneration = undefined;
        this.webviewReady = false;
        this.pendingAdminUpdate = false;
        this.messageQueue = Promise.resolve();
        this.selectedImageFile = undefined;
        this.disposePanelResources();
        this.clearReconciliationTimers();
        this.operationSubscription.dispose();
        panel?.dispose();
    }

    private enqueueMessage(panel: vscode.WebviewPanel, generation: number, message: unknown): void {
        this.messageQueue = this.messageQueue
            .then(() => this.handleMessage(panel, generation, message))
            .catch(error => {
                if (this.isActive(panel, generation)) {
                    void vscode.window.showErrorMessage(getErrorMessage(error));
                }
            });
    }

    private async handleMessage(panel: vscode.WebviewPanel, generation: number, message: unknown): Promise<void> {
        if (!this.isActive(panel, generation) || !isRecord(message) || typeof message.command !== 'string') {
            return;
        }

        switch (message.command) {
            case 'ready':
                this.webviewReady = true;
                this.flushPendingAdminUpdate(panel, generation);
                if (this.state.status === 'loading' && !this.refreshPromise) {
                    await this.refresh(panel, generation);
                }
                return;
            case 'refresh':
            case 'retry':
                await this.refresh(panel, generation);
                this.completeOperation(panel, message.command);
                return;
            case 'selectImageFile':
                this.operationInFlight = true;
                this.operationGeneration = generation;
                try {
                    await this.selectImageFile(panel, generation);
                } catch (error) {
                    this.completeOperation(panel, message.command);
                    throw error;
                } finally {
                    this.clearOperation(panel, generation);
                    this.flushPendingAdminUpdate(panel, generation);
                }
                return;
            case 'selectTab':
                this.selectTab(message.tab);
                return;
            case 'search':
                this.updateSearch(message.value);
                return;
            case 'setLogOpen':
                if (typeof message.open === 'boolean') {
                    this.setLogOpen(panel, generation, message.open);
                }
                return;
            case 'setSelectOpen':
                if (typeof message.open === 'boolean') {
                    this.setSelectOpen(panel, generation, message.open);
                }
                return;
        }

        if (!ADMIN_ACTIONS.has(message.command)) {
            return;
        }

        try {
            this.operationInFlight = true;
            this.operationGeneration = generation;
            if (this.refreshPromise) {
                await this.refreshPromise;
            }
            if (!this.isActive(panel, generation)) {
                return;
            }
            const adminApi = await this.authorize(panel, generation);
            if (!adminApi || !this.isActive(panel, generation)) {
                return;
            }
            if (message.command === 'getContainerLog') {
                const containerId = requireText(message.containerId, '容器 ID 不能为空');
                const log = await adminApi.getContainerLog(containerId);
                if (this.isActive(panel, generation)) {
                    await panel.webview.postMessage({ command: 'containerLog', containerId, log });
                }
                return;
            }
            if (message.command === 'checkImagePushStates') {
                const list = await adminApi.checkImagePushStates();
                if (this.isActive(panel, generation)) {
                    this.state.images = list.images;
                    this.postAdminUpdate(panel, generation);
                }
                return;
            }
            const changed = await this.executeAction(adminApi, message);
            if (changed) {
                await this.refresh(panel, generation, false, true);
            }
        } catch (error) {
            if (this.isActive(panel, generation)) {
                void vscode.window.showErrorMessage(getErrorMessage(error));
            }
        } finally {
            this.flushPendingAdminUpdate(panel, generation);
            this.completeOperation(panel, message.command);
            this.clearOperation(panel, generation);
        }
    }

    private clearOperation(panel: vscode.WebviewPanel, generation: number): void {
        if (this.panel !== panel || this.generation !== generation) {
            return;
        }
        this.operationInFlight = false;
        this.operationGeneration = undefined;
    }

    private async authorize(panel: vscode.WebviewPanel, generation: number, showError = true): Promise<AdminRestApi | undefined> {
        let baseUrl = '';
        try {
            const settings = this.getSettings();
            if (!settings.backendApiUrl) {
                throw new Error('未配置后端 TestAgent Cloud 管理服务的 API 地址');
            }
            baseUrl = settings.backendApiUrl;

            const userId = (await this.userIdProvider.getCurrentUserId()).trim();
            if (!userId) {
                throw new Error('未获取到当前用户 ID，无法校验管理员权限');
            }

            const userApi = this.userApiFactory(settings.backendApiUrl);
            const result = await userApi.checkAdmin({ user_id: userId });
            if (!result.admin) {
                throw new AdminAccessDeniedError('当前登录用户无法使用管理员页面');
            }
            if (!this.isActive(panel, generation)) {
                return undefined;
            }
            return this.adminApiFactory(settings.backendApiUrl, userId);
        } catch (error) {
            this.logger?.error('管理员面板权限校验失败', { baseUrl, error });
            if (showError && this.isActive(panel, generation)) {
                this.showPageError(error);
            }
            return undefined;
        }
    }

    private refresh(panel: vscode.WebviewPanel, generation: number, showLoading = true, allowDuringOperation = false): Promise<void> {
        if (!this.isActive(panel, generation)) {
            return Promise.resolve();
        }
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        if (this.logOpen || this.selectOpen || this.isOperationInFlight(generation) && !allowDuringOperation) {
            return Promise.resolve();
        }

        const wasReady = this.state.status === 'ready';
        if (showLoading && !wasReady && this.state.status !== 'loading') {
            this.state.status = 'loading';
            this.state.error = undefined;
            this.setPanelHtml(panel);
        }

        const refreshPromise = (async () => {
            const adminApi = await this.authorize(panel, generation, showLoading || allowDuringOperation || this.state.status === 'loading');
            if (!adminApi || !this.isActive(panel, generation)) {
                return;
            }

            try {
                const data = await loadAdminData(adminApi, this.logger);
                if (!this.isActive(panel, generation)) {
                    return;
                }
                const dataChanged = hasAdminDataChanged(this.state, data);
                this.state = {
                    ...this.state,
                    ...data,
                    status: 'ready',
                    error: undefined,
                };
                if (!wasReady) {
                    this.setPanelHtml(panel);
                } else if (dataChanged || this.pendingAdminUpdate) {
                    if (this.logOpen || this.selectOpen || this.isOperationInFlight(generation) && !allowDuringOperation) {
                        this.pendingAdminUpdate = true;
                    } else {
                        this.postAdminUpdate(panel, generation);
                    }
                }
            } catch (error) {
                this.logger?.error('管理员面板数据刷新失败', { error });
                if ((showLoading || allowDuringOperation) && this.isActive(panel, generation)) {
                    this.showPageError(error);
                }
            }
        })().finally(() => {
            if (this.panel === panel && this.generation === generation) {
                this.refreshPromise = undefined;
            }
        });

        this.refreshPromise = refreshPromise;
        return refreshPromise;
    }

    private postAdminUpdate(panel: vscode.WebviewPanel, generation: number): void {
        if (!this.isActive(panel, generation)) {
            return;
        }
        this.pendingAdminUpdate = !this.webviewReady;
        void panel.webview.postMessage({
            command: 'adminUpdate',
            html: renderAdminContent(this.getRenderedState()),
        }).then(() => undefined, () => {
            if (this.isActive(panel, generation)) {
                this.webviewReady = false;
                this.pendingAdminUpdate = true;
            }
        });
    }

    private flushPendingAdminUpdate(panel: vscode.WebviewPanel, generation: number): void {
        if (!this.pendingAdminUpdate || this.logOpen || this.selectOpen) {
            return;
        }
        this.pendingAdminUpdate = false;
        this.postAdminUpdate(panel, generation);
    }

    private async executeAction(adminApi: AdminRestApi, message: Record<string, unknown>): Promise<boolean> {
        switch (message.command) {
            case 'uploadImage':
                return this.uploadImage(adminApi, message);
            case 'pushImage':
                await adminApi.pushImage({ full_name: requireText(message.fullName, '镜像名称不能为空') });
                return true;
            case 'setDefaultImage':
                await adminApi.setDefaultImage({
                    full_name: requireText(message.fullName, '镜像名称不能为空'),
                    type: requireContainerType(message.type),
                });
                return true;
            case 'unsetDefaultImage':
                await adminApi.unsetDefaultImage(containerTypeOf(message.type));
                return true;
            case 'deleteImage':
                return this.deleteImage(adminApi, message);
            case 'createContainer':
                await adminApi.createContainer(toAdminCreateRequest(message));
                return true;
            case 'setLimit':
                await adminApi.setContainerLimit(toLimitRequest(message));
                return true;
            case 'deleteOrphanContainers':
                return this.deleteOrphanContainers(adminApi, message);
            case 'containerAction':
                return this.containerAction(adminApi, message);
            case 'addWhitelistUser':
                await adminApi.addWhitelistUser({ user_id: requireText(message.user_id, '用户 ID 不能为空') });
                return true;
            case 'deleteWhitelistUser':
                await adminApi.deleteWhitelistUser({ user_id: requireText(message.userId, '用户 ID 不能为空') });
                return true;
            case 'addAdminUser':
                await adminApi.addAdminUser({ user_id: requireText(message.user_id, '用户 ID 不能为空') });
                return true;
            case 'deleteAdminUser':
                await adminApi.deleteAdminUser({ user_id: requireText(message.userId, '用户 ID 不能为空') });
                return true;
            default:
                return false;
        }
    }

    private async uploadImage(adminApi: AdminRestApi, message: Record<string, unknown>): Promise<boolean> {
        const selected = this.selectedImageFile ?? await this.chooseImageFile();
        if (!selected) {
            return false;
        }

        const input: UploadImageFileInput = {
            filePath: selected.fsPath,
            filename: selected.filename,
            registry: optionalText(message.registry),
            namespace: optionalText(message.namespace),
            auto_push: asBoolean(message.autoPush, true),
        };
        await adminApi.uploadImage(input);
        this.selectedImageFile = undefined;
        this.state.selectedImageFilename = undefined;
        return true;
    }

    private async selectImageFile(panel: vscode.WebviewPanel, generation: number): Promise<void> {
        const selected = await this.chooseImageFile();
        if (!selected || !this.isActive(panel, generation)) {
            this.completeOperation(panel, 'selectImageFile');
            return;
        }
        this.selectedImageFile = selected;
        this.state.selectedImageFilename = selected.filename;
        this.setPanelHtml(panel);
        await panel.webview.postMessage({ command: 'imageFileSelected', filename: selected.filename });
        this.completeOperation(panel, 'selectImageFile');
    }

    private async chooseImageFile(): Promise<{ fsPath: string; filename: string } | undefined> {
        const selected = (await this.showOpenDialog({
            title: '请选择 TSCode Server Docker 镜像归档文件',
            openLabel: '选择',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { '镜像归档文件': ['tar', 'tar.gz'] },
        }))?.[0];
        if (!selected?.fsPath) {
            return undefined;
        }

        const filename = path.basename(selected.fsPath);
        if (!/\.tar(?:\.gz)?$/i.test(filename)) {
            throw new Error('镜像归档文件必须是 .tar 或 .tar.gz 格式');
        }
        return { fsPath: selected.fsPath, filename };
    }

    private async deleteImage(adminApi: AdminRestApi, message: Record<string, unknown>): Promise<boolean> {
        const fullName = requireText(message.fullName, '镜像名称不能为空');
        const alsoRegistry = asBoolean(message.alsoRegistry, true);
        const confirmed = await confirmAction(
            `确定要删除镜像「${fullName}」吗？${alsoRegistry ? '并同时删除注册表 (镜像仓库) 中的镜像。' : '且仅删除本地镜像。'}`,
            '删除',
        );
        if (!confirmed) {
            return false;
        }
        const request: ImageDeleteRequest = { full_name: fullName, also_registry: alsoRegistry };
        await adminApi.deleteImage(request);
        return true;
    }

    private async deleteOrphanContainers(adminApi: AdminRestApi, message: Record<string, unknown>): Promise<boolean> {
        const ids = optionalText(message.orphanContainerIds)
            ?.split(',')
            .map(value => value.trim())
            .filter(Boolean) ?? this.state.orphanContainerIds;
        if (!ids.length) {
            return false;
        }
        const confirmed = await confirmAction(`确定要删除全部 ${ids.length} 个孤儿容器吗？`, '删除');
        if (!confirmed) {
            return false;
        }
        await adminApi.deleteOrphanContainers({ container_ids: ids });
        return true;
    }

    private async containerAction(adminApi: AdminRestApi, message: Record<string, unknown>): Promise<boolean> {
        const containerId = requireText(message.containerId, '容器 ID 不能为空');
        const action = requireOneOf(message.action, ['start', 'stop', 'restart', 'delete', 'permanent-delete', 'expiration', 'restore'] as const, '无效容器操作');
        const container = this.state.containers.find(item => item.container_id === containerId);
        if (action === 'restart' && container && !container.business_deleted && container.status.toLowerCase() === 'failed') {
            throw new Error(`容器 "${containerId}" 处于失败状态，不能重启`);
        }

        if (action === 'delete' || action === 'permanent-delete') {
            const label = action === 'delete' ? '业务删除' : '永久删除';
            const confirmed = await confirmAction(`确定对容器「${containerId}」执行${label}吗？`, label);
            if (!confirmed) {
                return false;
            }
        }

        if (isContainerOperationAction(action)) {
            const operation = this.operationRegistry?.begin(containerId, action, 'admin');
            if (this.operationRegistry && !operation) {
                throw new Error(`容器 "${containerId}" 正在执行操作，请稍后重试`);
            }

            try {
                await vscode.window.withProgress({
                    title: `正在${getContainerOperationName(action)} TestAgent Cloud 服务`,
                    location: vscode.ProgressLocation.Notification,
                    cancellable: false,
                }, async progress => {
                    progress.report({ message: `容器 ${containerId}` });
                    await this.executeLifecycleAction(adminApi, containerId, action, message);
                });

                if (operation) {
                    const reconciling = this.operationRegistry?.setPhase(containerId, 'reconciling');
                    if (reconciling) {
                        this.scheduleReconciliationTimeout(reconciling);
                        const confirmed = await this.reconcileContainerOperation(reconciling);
                        if (!confirmed) {
                            void vscode.window.showInformationMessage(
                                `TestAgent Cloud 服务 "${containerId}" 已提交${getContainerOperationName(action)}，正在确认状态`,
                            );
                        }
                    }
                }
                return true;
            } catch (error) {
                if (operation && isRequestTimeoutError(error)) {
                    const reconciling = this.operationRegistry?.setPhase(containerId, 'reconciling');
                    if (reconciling) {
                        this.scheduleReconciliationTimeout(reconciling);
                        void this.reconcileContainerOperation(reconciling);
                    }
                    void vscode.window.showInformationMessage(
                        `TestAgent Cloud 服务 "${containerId}" 的${getContainerOperationName(action)}请求已等待 1 分钟，正在进行重试...`,
                    );
                    return true;
                }
                if (operation) {
                    this.operationRegistry?.complete(containerId, 'failed');
                }
                throw error;
            }
        }

        switch (action) {
            case 'expiration':
                await adminApi.setExpiration(containerId, toExpirationRequest(message));
                return true;
        }
    }

    private async executeLifecycleAction(
        adminApi: AdminRestApi,
        containerId: string,
        action: ContainerOperationAction,
        message: Record<string, unknown>,
    ): Promise<void> {
        switch (action) {
            case 'start':
                await adminApi.startContainer(containerId);
                return;
            case 'stop':
                await adminApi.stopContainer(containerId);
                return;
            case 'restart':
                await adminApi.restartContainer(containerId);
                return;
            case 'delete':
                await adminApi.deleteContainer(containerId);
                return;
            case 'permanent-delete':
                await adminApi.permanentDeleteContainer(containerId);
                return;
            case 'restore':
                await adminApi.restoreContainer(containerId, toExpirationRequest(message));
                return;
        }
    }

    private selectTab(value: unknown): void {
        if (!isAdminTab(value)) {
            return;
        }
        this.state.activeTab = value;
        this.state.search = '';
        if (this.panel && this.state.status === 'ready') {
            this.setPanelHtml(this.panel);
        }
    }

    private updateSearch(value: unknown): void {
        if (typeof value !== 'string') {
            return;
        }
        this.state.search = value;
        if (this.panel && this.state.status === 'ready') {
            this.setPanelHtml(this.panel);
        }
    }

    private completeOperation(panel: vscode.WebviewPanel, action: string): void {
        if (!this.panel || this.panel !== panel) {
            return;
        }
        void panel.webview.postMessage({ command: 'operationComplete', action })
            .then(() => undefined, () => undefined);
    }

    private handleContainerOperationEvent(event: ContainerOperationEvent): void {
        const panel = this.panel;
        if (event.type === 'completed') {
            this.clearReconciliationTimer(event.operation.containerId);
            if (event.operation.source === 'admin' && event.outcome === 'succeeded') {
                void vscode.window.showInformationMessage(
                    `TestAgent Cloud 服务 "${event.operation.containerId}" 已${getContainerOperationName(event.operation.action)}`,
                );
            }
            if (event.operation.source === 'admin' && event.outcome === 'failed' && event.operation.phase === 'reconciling') {
                void vscode.window.showWarningMessage(
                    `TestAgent Cloud 服务 "${event.operation.containerId}" 的${getContainerOperationName(event.operation.action)}结果暂时无法确认，请刷新后再试`,
                );
            }
            if (panel && this.state.status === 'ready') {
                void this.refresh(panel, this.generation, false, true);
            }
            return;
        }
        if (panel && this.state.status === 'ready') {
            this.postAdminUpdate(panel, this.generation);
        }
    }

    private getRenderedState(): AdminPanelState {
        if (!this.operationRegistry) {
            return this.state;
        }
        return {
            ...this.state,
            containers: this.state.containers.map(container => {
                const operation = this.operationRegistry?.get(container.container_id);
                if (!operation || container.business_deleted && operation.action !== 'restore') {
                    return container;
                }
                return {
                    ...container,
                    ...(operation.action === 'restore' ? { business_deleted: false, deleted_at: null } : {}),
                    status: getContainerOperationStatus(operation.action),
                };
            }),
        };
    }

    private async reconcileContainerOperation(operation: ContainerOperationState): Promise<boolean> {
        if (!this.operationRegistry) {
            return true;
        }
        if (!this.onContainerOperation) {
            this.operationRegistry.complete(operation.containerId);
            return true;
        }
        try {
            const confirmed = await this.onContainerOperation(operation);
            if (confirmed) {
                this.operationRegistry.complete(operation.containerId);
                return true;
            }
        } catch {
            // The regular ContainerSync timer will retry reconciliation.
        }
        return false;
    }

    private scheduleReconciliationTimeout(operation: ContainerOperationState): void {
        this.clearReconciliationTimer(operation.containerId);
        const timer = setTimeout(() => {
            this.reconciliationTimers.delete(operation.containerId);
            const current = this.operationRegistry?.get(operation.containerId);
            if (!current || current.phase !== 'reconciling' || current.action !== operation.action) {
                return;
            }
            this.operationRegistry?.complete(operation.containerId, 'failed');
        }, OPERATION_RECONCILIATION_TIMEOUT_MS);
        this.reconciliationTimers.set(operation.containerId, timer);
    }

    private clearReconciliationTimer(containerId: string): void {
        const timer = this.reconciliationTimers.get(containerId);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        this.reconciliationTimers.delete(containerId);
    }

    private clearReconciliationTimers(): void {
        for (const timer of this.reconciliationTimers.values()) {
            clearTimeout(timer);
        }
        this.reconciliationTimers.clear();
    }

    private showPageError(error: unknown): void {
        this.state.status = error instanceof AdminAccessDeniedError ? 'forbidden' : 'error';
        this.state.error = getErrorMessage(error);
        if (this.panel) {
            this.setPanelHtml(this.panel);
        }
    }

    private setPanelHtml(panel: vscode.WebviewPanel): void {
        if (!this.panel || this.panel !== panel || this.disposed || this.logOpen || this.selectOpen) {
            return;
        }
        this.webviewReady = false;
        this.pendingAdminUpdate = false;
        panel.webview.html = renderAdminPage(this.getRenderedState(), createNonce(), panel.webview.cspSource);
    }

    private setLogOpen(panel: vscode.WebviewPanel, generation: number, open: boolean): void {
        if (!this.isActive(panel, generation) || this.logOpen === open) {
            return;
        }
        this.logOpen = open;
        if (open) {
            this.clearRefreshTimer();
        } else {
            this.startRefreshTimer(panel, generation);
            this.flushPendingAdminUpdate(panel, generation);
        }
    }

    private setSelectOpen(panel: vscode.WebviewPanel, generation: number, open: boolean): void {
        if (!this.isActive(panel, generation) || this.selectOpen === open) {
            return;
        }
        this.selectOpen = open;
        if (open) {
            this.clearRefreshTimer();
        } else {
            this.startRefreshTimer(panel, generation);
            this.flushPendingAdminUpdate(panel, generation);
        }
    }

    private startRefreshTimer(panel: vscode.WebviewPanel, generation: number): void {
        this.clearRefreshTimer();
        if (this.logOpen || this.selectOpen) {
            return;
        }
        this.scheduleRefreshTimer(panel, generation);
    }

    private scheduleRefreshTimer(panel: vscode.WebviewPanel, generation: number): void {
        if (!this.isActive(panel, generation) || this.logOpen || this.selectOpen) {
            return;
        }
        let intervalSeconds: number;
        try {
            intervalSeconds = this.getSettings().statusSyncInterval;
        } catch {
            return;
        }
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            if (!this.isActive(panel, generation)) {
                return;
            }
            if (this.logOpen || this.selectOpen || this.isOperationInFlight(generation)) {
                this.scheduleRefreshTimer(panel, generation);
                return;
            }
            void this.refresh(panel, generation, false)
                .finally(() => this.scheduleRefreshTimer(panel, generation));
        }, intervalSeconds * 1000);
    }

    private clearRefreshTimer(): void {
        if (!this.refreshTimer) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
    }

    private isActive(panel: vscode.WebviewPanel, generation: number): boolean {
        return !this.disposed && this.panel === panel && this.generation === generation;
    }

    private isOperationInFlight(generation: number): boolean {
        return this.operationInFlight && this.operationGeneration === generation;
    }

    private handlePanelDisposed(panel: vscode.WebviewPanel, generation: number): void {
        if (this.panel !== panel || this.generation !== generation) {
            return;
        }
        this.panel = undefined;
        this.selectedImageFile = undefined;
        this.logOpen = false;
        this.selectOpen = false;
        this.operationInFlight = false;
        this.operationGeneration = undefined;
        this.webviewReady = false;
        this.pendingAdminUpdate = false;
        this.messageQueue = Promise.resolve();
        this.generation++;
        this.clearRefreshTimer();
        this.refreshPromise = undefined;
        this.loadPromise = undefined;
        this.disposePanelResources();
    }

    private disposePanelResources(): void {
        const subscriptions = this.panelDisposables;
        this.panelDisposables = [];
        for (const subscription of subscriptions) {
            subscription.dispose();
        }
    }
}

const ADMIN_ACTIONS = new Set([
    'uploadImage',
    'pushImage',
    'checkImagePushStates',
    'setDefaultImage',
    'unsetDefaultImage',
    'deleteImage',
    'createContainer',
    'setLimit',
    'deleteOrphanContainers',
    'getContainerLog',
    'containerAction',
    'addWhitelistUser',
    'deleteWhitelistUser',
    'addAdminUser',
    'deleteAdminUser',
]);

class AdminAccessDeniedError extends Error {
}

function createInitialState(): AdminPanelState {
    return {
        status: 'loading',
        activeTab: 'images',
        search: '',
        images: [],
        defaultImages: ADMIN_CONTAINER_TYPES.map(entry => ({ type: entry.type, fullName: null })),
        containers: [],
        orphanContainerIds: [],
        whitelistUsers: [],
        adminUsers: [],
    };
}

async function loadAdminData(adminApi: AdminRestApi, logger?: PanelLogger): Promise<AdminData> {
    const request = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        try {
            return await operation();
        } catch (error) {
            logger?.error(`管理员面板数据加载失败：${label}`, { elapsedMs: Date.now() - startedAt, error });
            throw error;
        }
    };

    const [images, defaultImages, containers, orphanContainers, stats, limit, whitelistUsers, adminUsers] = await Promise.all([
        request('镜像列表', () => adminApi.listImages()),
        request('默认镜像', () => loadDefaultImages(adminApi)),
        request('容器列表', () => adminApi.listContainers()),
        request('孤儿容器列表', () => adminApi.listOrphanContainers()),
        request('服务状态', () => adminApi.getState()),
        request('容器数量限制', () => adminApi.getContainerLimit()),
        request('白名单用户列表', () => adminApi.listWhitelistUsers()),
        request('管理员用户列表', () => adminApi.listAdminUsers()),
    ]);
    return {
        images: images.images,
        defaultImages,
        containers: containers.containers,
        orphanContainerIds: orphanContainers.container_ids,
        stats,
        limit,
        whitelistUsers: whitelistUsers.user_ids,
        adminUsers: adminUsers.user_ids,
    };
}

async function loadDefaultImages(adminApi: AdminRestApi): Promise<AdminDefaultImage[]> {
    const pairs = await Promise.all(ADMIN_CONTAINER_TYPES.map(async entry => {
        const response = await adminApi.getDefaultImage(entry.type);
        return { type: entry.type, fullName: response.full_name ?? null };
    }));
    return pairs;
}

function hasAdminDataChanged(previous: AdminPanelState, next: AdminData): boolean {
    return JSON.stringify({
        images: previous.images,
        defaultImages: previous.defaultImages,
        containers: previous.containers,
        orphanContainerIds: previous.orphanContainerIds,
        stats: previous.stats,
        limit: previous.limit,
        whitelistUsers: previous.whitelistUsers,
        adminUsers: previous.adminUsers,
    }) !== JSON.stringify(next);
}

function toAdminCreateRequest(message: Record<string, unknown>): AdminCreateContainerRequest {
    const request: AdminCreateContainerRequest = {
        user_id: requireText(message.user_id, '用户 ID 不能为空'),
        type: containerTypeOf(message.type) ?? 'testagent_cloud',
    };
    const giteeBranch = optionalText(message.gitee_branch);
    const image = optionalText(message.image);
    const hasSeparateGiteeFields = optionalText(message.gitee_user) !== undefined
        || optionalText(message.gitee_repository) !== undefined
        || optionalText(message.gitee_url) !== undefined;
    let giteeMode = 'full';
    if (message.giteeMode === 'none') {
        giteeMode = 'none';
    } else if (message.giteeMode === 'parts' || message.giteeMode === undefined && hasSeparateGiteeFields) {
        giteeMode = 'parts';
    }
    if (giteeMode === 'full') {
        const fullUrl = optionalText(message.gitee_full_url);
        if (fullUrl !== undefined) {
            Object.assign(request, parseGiteeRepositoryUrl(fullUrl));
        }
    } else if (giteeMode === 'parts') {
        const giteeUser = optionalText(message.gitee_user);
        const giteeRepository = optionalText(message.gitee_repository);
        const giteeUrl = optionalText(message.gitee_url);
        const separateGiteeFields = [giteeUser, giteeRepository, giteeUrl];
        if (separateGiteeFields.some(value => value !== undefined) && separateGiteeFields.some(value => value === undefined)) {
            throw new Error('需要完整填写码云用户名、仓库名和网址前缀');
        }
        if (giteeUser !== undefined) {
            request.gitee_user = giteeUser;
        }
        if (giteeRepository !== undefined) {
            request.gitee_repository = giteeRepository;
        }
        if (giteeUrl !== undefined) {
            request.gitee_url = giteeUrl;
        }
    }
    if (giteeBranch !== undefined) {
        request.gitee_branch = giteeBranch;
    }
    if (image !== undefined) {
        request.image = image;
    }
    request.authorize_general_account = asBoolean(message.authorize_general_account, false);
    const expiration = optionalNonNegativeInteger(message.expiration_hours, '有效期');
    const cpu = optionalPositiveNumber(message.cpu, 'CPU');
    const memory = optionalPositiveInteger(message.memory, '内存');
    if (expiration !== undefined) {
        request.expiration_hours = expiration;
    }
    if (cpu !== undefined) {
        request.cpu = cpu;
    }
    if (memory !== undefined) {
        request.memory = memory;
    }
    return request;
}

function parseGiteeRepositoryUrl(value: string): Pick<AdminCreateContainerRequest, 'gitee_user' | 'gitee_repository' | 'gitee_url'> {
    const normalizedValue = value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    const parsed = parseRepositoryUrl(normalizedValue);
    if (!parsed) {
        throw new Error('码云地址格式无效');
    }
    return {
        gitee_user: parsed.user,
        gitee_repository: parsed.repository,
        gitee_url: parsed.url,
    };
}

function toLimitRequest(message: Record<string, unknown>): ContainerLimitRequest {
    return {
        container_limit: requireNonNegativeInteger(message.container_limit, '数量上限'),
        cpu: requirePositiveNumber(message.cpu, 'CPU'),
        memory: requirePositiveInteger(message.memory, '内存'),
    };
}

function toExpirationRequest(message: Record<string, unknown>): ExpirationRequest {
    return { expiration_hours: requireNonNegativeInteger(message.expirationHours ?? message.expiration_hours, '有效期') };
}

async function confirmAction(message: string, confirmLabel: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return result === confirmLabel;
}

function requireText(value: unknown, message: string): string {
    const text = optionalText(value);
    if (!text) {
        throw new Error(message);
    }
    return text;
}

function requireContainerType(value: unknown): ContainerTypeValue {
    const type = containerTypeOf(value);
    if (!type) {
        throw new Error('请选择容器类型');
    }
    return type;
}

function optionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim();
    return text || undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
    if (typeof value === 'string' && allowed.includes(value as T)) {
        return value as T;
    }
    throw new Error(message);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
    const number = requireNumber(value, label);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${label}必须是大于或等于 0 的整数`);
    }
    return number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
    if (isBlank(value)) {
        return undefined;
    }
    return requireNonNegativeInteger(value, label);
}

function requirePositiveInteger(value: unknown, label: string): number {
    const number = requireNumber(value, label);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${label}必须是大于 0 的整数`);
    }
    return number;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
    if (isBlank(value)) {
        return undefined;
    }
    return requirePositiveInteger(value, label);
}

function requirePositiveNumber(value: unknown, label: string): number {
    const number = requireNumber(value, label);
    if (number <= 0) {
        throw new Error(`${label}必须是大于 0 的数字`);
    }
    return number;
}

function optionalPositiveNumber(value: unknown, label: string): number | undefined {
    if (isBlank(value)) {
        return undefined;
    }
    return requirePositiveNumber(value, label);
}

function requireNumber(value: unknown, label: string): number {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) {
        throw new Error(`${label}必须是数字`);
    }
    return number;
}

function isBlank(value: unknown): boolean {
    return value === undefined || value === null || value === '' || typeof value === 'string' && !value.trim();
}

function isAdminTab(value: unknown): value is AdminTab {
    return value === 'images' || value === 'containers' || value === 'whitelist' || value === 'adminUsers';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
    return formatRestClientError(error);
}

function isRequestTimeoutError(error: unknown): boolean {
    return error instanceof RestClientError && error.code === REST_ERROR_CODES.TIMEOUT;
}

function createNonce(): string {
    return randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}
