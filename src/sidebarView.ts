import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ContainerConfig } from './containerConfig';
import {
    ContainerSync,
    getContainerHostName,
    getUniqueHostName,
    type ContainerSyncError,
    type ContainerSyncResult,
    type SyncedContainer,
} from './containerSync';
import {
    ContainerOperationAction,
    ContainerOperationOutcome,
    ContainerOperationRegistry,
    getContainerOperationStatus,
} from './containerOperations';
import { parseContainerEndpoint } from './containerEndpoint';
import { parseGiteeRepositoryUrl } from './giteeRepository';
import { getEffectiveRemoteUserName, getRemoteSettings, type RemoteSettings } from './settings';
import { WEBVIEW_SCRIPT } from './webviewScript';
import { UserIdProvider } from './user';
import { type PublicUserContainerApi } from './api/publicApi';
import { formatRestClientError, type UserRestApi } from './api/restClient';

export type SidebarSyncListener = (result: ContainerSyncResult) => void;

export class SidebarSyncState {
    private currentResult: ContainerSyncResult = {
        containers: [],
        changed: false,
    };
    private readonly listeners = new Set<SidebarSyncListener>();
    private disposed = false;

    public getState(): ContainerSyncResult {
        return {
            ...this.currentResult,
            containers: this.currentResult.containers.slice(),
        };
    }

    public update(result: ContainerSyncResult): void {
        if (this.disposed) {
            return;
        }

        this.currentResult = result;
        for (const listener of this.listeners) {
            listener(result);
        }
    }

    public subscribe(listener: SidebarSyncListener): { dispose: () => void } {
        if (this.disposed) {
            return { dispose: () => undefined };
        }

        this.listeners.add(listener);
        return {
            dispose: () => this.listeners.delete(listener),
        };
    }

    public dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }
}

export interface SidebarViewOptions {
    state: SidebarSyncState;
    sync: Pick<ContainerSync, 'refresh'> & Partial<Pick<ContainerSync, 'refreshAfterMutation' | 'runMutation' | 'markContainerDeleted' | 'clearContainerDeleted'>>;
    config: ContainerConfig;
    publicApi: PublicUserContainerApi;
    userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    userApiFactory: (baseUrl: string) => UserRestApi;
    getSettings?: () => RemoteSettings;
    cloudMode?: boolean;
    getCloudMode?: () => boolean | Thenable<boolean>;
    isDisconnected?: () => boolean;
    onOpenConfig?: () => void | Promise<void>;
    onOpenAdmin?: () => void | Promise<void>;
    onConnect?: (host: string) => void | Promise<void>;
    onDisconnect?: () => void | Promise<void>;
    operationRegistry?: ContainerOperationRegistry;
    showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick?: (
        items: readonly string[],
        options: vscode.QuickPickOptions & { canPickMany: true },
    ) => Thenable<string[] | undefined>;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly state: SidebarSyncState;
    private readonly sync: Pick<ContainerSync, 'refresh'> & Partial<Pick<ContainerSync, 'refreshAfterMutation' | 'runMutation' | 'markContainerDeleted' | 'clearContainerDeleted'>>;
    private readonly config: ContainerConfig;
    private readonly publicApi: PublicUserContainerApi;
    private readonly userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    private readonly userApiFactory: (baseUrl: string) => UserRestApi;
    private readonly getSettings: () => RemoteSettings;
    private readonly getCloudMode: () => boolean | Thenable<boolean>;
    private cloudMode: boolean;
    private readonly isDisconnected: () => boolean;
    private readonly onOpenConfig: (() => void | Promise<void>) | undefined;
    private readonly onOpenAdmin: (() => void | Promise<void>) | undefined;
    private readonly onConnect: ((host: string) => void | Promise<void>) | undefined;
    private readonly onDisconnect: (() => void | Promise<void>) | undefined;
    private readonly operationRegistry: ContainerOperationRegistry | undefined;
    private readonly showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    private readonly showQuickPick: (
        items: readonly string[],
        options: vscode.QuickPickOptions & { canPickMany: true },
    ) => Thenable<string[] | undefined>;
    private readonly stateSubscription: { dispose: () => void };
    private readonly operationSubscription: { dispose: () => void };
    private readonly optimisticallyRemovedContainerIds = new Set<string>();

    private webviewView: vscode.WebviewView | undefined;
    private messageSubscription: vscode.Disposable | undefined;
    private viewDisposeSubscription: vscode.Disposable | undefined;
    private viewVisibilitySubscription: vscode.Disposable | undefined;
    private adminCheckInFlight: Promise<void> | undefined;
    private createInFlight: Promise<void> | undefined;
    private readonly containerOperationCounts = new Map<string, number>();
    private pageError: ContainerSyncError | undefined;
    private pageReady = false;
    private adminAllowed = false;
    private disposed = false;

    constructor(options: SidebarViewOptions) {
        this.state = options.state;
        this.sync = options.sync;
        this.config = options.config;
        this.publicApi = options.publicApi;
        this.userIdProvider = options.userIdProvider;
        this.userApiFactory = options.userApiFactory;
        this.getSettings = options.getSettings ?? getRemoteSettings;
        this.cloudMode = options.cloudMode === true;
        this.getCloudMode = options.getCloudMode ?? (() => this.cloudMode);
        this.isDisconnected = options.isDisconnected ?? (() => !vscode.env.remoteName);
        this.onOpenConfig = options.onOpenConfig;
        this.onOpenAdmin = options.onOpenAdmin;
        this.onConnect = options.onConnect;
        this.onDisconnect = options.onDisconnect;
        this.operationRegistry = options.operationRegistry;
        this.showInputBox = options.showInputBox ?? (inputOptions => vscode.window.showInputBox(inputOptions));
        this.showQuickPick = options.showQuickPick ?? ((items, quickPickOptions) => vscode.window.showQuickPick(items, quickPickOptions));
        this.stateSubscription = this.state.subscribe(() => this.handleSyncStateUpdated());
        this.operationSubscription = this.operationRegistry?.subscribe(() => this.render()) ?? { dispose: () => undefined };
    }

    public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }

        this.messageSubscription?.dispose();
        this.viewDisposeSubscription?.dispose();
        this.viewVisibilitySubscription?.dispose();
        this.webviewView = webviewView;
        this.pageReady = false;
        this.pageError = undefined;
        this.adminAllowed = false;
        this.cloudMode = await this.getCloudMode();
        if (this.disposed || this.webviewView !== webviewView) {
            return;
        }

        webviewView.webview.options = {
            enableScripts: true,
            enableForms: false,
            localResourceRoots: [],
        };
        this.messageSubscription = webviewView.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        this.viewDisposeSubscription = webviewView.onDidDispose(() => {
            if (this.webviewView !== webviewView) {
                return;
            }
            this.webviewView = undefined;
            this.messageSubscription?.dispose();
            this.viewVisibilitySubscription?.dispose();
            this.messageSubscription = undefined;
            this.viewDisposeSubscription = undefined;
            this.viewVisibilitySubscription = undefined;
        });
        this.viewVisibilitySubscription = webviewView.onDidChangeVisibility?.(() => {
            if (webviewView.visible) {
                void this.refreshForVisibleView(webviewView);
            }
        });

        this.render();
        return this.preparePage();
    }

    public createContainerFromPrompt(): Promise<void> {
        if (this.createInFlight) {
            return this.createInFlight;
        }

        this.createInFlight = this.performCreateContainer()
            .catch(error => {
                this.showError(error);
            })
            .finally(() => {
                this.createInFlight = undefined;
            });
        return this.createInFlight;
    }

    public async refreshCloudMode(): Promise<void> {
        const webviewView = this.webviewView;
        if (!webviewView || this.disposed) {
            return;
        }
        await this.refreshForVisibleView(webviewView);
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.stateSubscription.dispose();
        this.operationSubscription.dispose();
        this.messageSubscription?.dispose();
        this.viewDisposeSubscription?.dispose();
        this.viewVisibilitySubscription?.dispose();
        this.messageSubscription = undefined;
        this.viewDisposeSubscription = undefined;
        this.viewVisibilitySubscription = undefined;
        this.containerOperationCounts.clear();
        this.optimisticallyRemovedContainerIds.clear();
        this.webviewView = undefined;
    }

    private async refreshForVisibleView(webviewView: vscode.WebviewView): Promise<void> {
        if (this.disposed || this.webviewView !== webviewView) {
            return;
        }

        this.cloudMode = await this.getCloudMode();
        if (this.disposed || this.webviewView !== webviewView) {
            return;
        }
        this.pageReady = false;
        this.pageError = undefined;
        this.adminAllowed = false;
        this.render();
        await this.preparePage();
    }

    private async preparePage(): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (this.cloudMode) {
            this.pageReady = true;
            this.render();
            return;
        }

        this.pageReady = false;
        this.pageError = undefined;
        this.adminAllowed = false;
        this.render();

        let settings: RemoteSettings;
        try {
            settings = this.getSettings();
        } catch (error) {
            this.pageError = toSidebarError(error, 'settings_error', '读取 TestAgent Cloud 服务设置失败');
            this.render();
            return;
        }

        if (!settings.backendApiUrl) {
            this.pageError = {
                code: 'api_url_missing',
                message: '未配置后端 TestAgent Cloud 管理服务的 API 地址',
            };
            this.render();
            return;
        }

        let userId: string;
        try {
            userId = await this.userIdProvider.getCurrentUserId();
        } catch (error) {
            this.pageError = toSidebarError(error, 'user_id_missing', '未获取到当前用户 ID');
            this.render();
            return;
        }
        if (!userId) {
            this.pageError = {
                code: 'user_id_missing',
                message: '未获取到当前用户 ID',
            };
            this.render();
            return;
        }

        if (this.disposed) {
            return;
        }
        this.pageReady = true;
        this.render();
        void this.checkAdmin(userId, settings.backendApiUrl);
    }

    private async checkAdmin(userId: string, baseUrl: string): Promise<void> {
        if (this.adminCheckInFlight || this.disposed || this.cloudMode) {
            return;
        }

        this.adminCheckInFlight = (async () => {
            try {
                const response = await this.userApiFactory(baseUrl).checkAdmin({ user_id: userId });
                if (!this.disposed) {
                    this.adminAllowed = response.admin;
                    this.render();
                }
            } catch {
                if (!this.disposed) {
                    this.adminAllowed = false;
                    this.render();
                }
            }
        })().finally(() => {
            this.adminCheckInFlight = undefined;
        });
        await this.adminCheckInFlight;
    }

    private render(): void {
        if (!this.webviewView || this.disposed) {
            return;
        }

        if (this.cloudMode) {
            this.setWebviewHtml(renderCloudHtml());
            return;
        }

        const result = this.state.getState();
        const containers = result.containers
            .filter(container => !this.optimisticallyRemovedContainerIds.has(container.containerId))
            .map(container => this.applyOperationOverlay(container));
        const activeOperationIds = new Set([
            ...this.containerOperationCounts.keys(),
            ...(this.operationRegistry?.list().map(operation => operation.containerId) ?? []),
        ]);
        const hasActiveOperation = activeOperationIds.size > 0;
        const error = this.pageError ?? result.error;
        if (error && !hasActiveOperation) {
            this.setWebviewHtml(renderErrorHtml(error.message));
            return;
        }
        if (!this.pageReady) {
            this.setWebviewHtml(renderLoadingHtml());
            return;
        }

        this.setWebviewHtml(renderSidebarHtml(
            containers,
            this.adminAllowed,
            activeOperationIds,
        ));
    }

    private handleSyncStateUpdated(): void {
        const result = this.state.getState();
        for (const containerId of this.optimisticallyRemovedContainerIds) {
            if (!result.containers.some(container => container.containerId === containerId)) {
                this.optimisticallyRemovedContainerIds.delete(containerId);
            }
        }
        this.render();
    }

    private optimisticallyRemoveContainer(containerId: string): void {
        this.optimisticallyRemovedContainerIds.add(containerId);
        this.render();
    }

    private restoreOptimisticallyRemovedContainer(containerId: string): void {
        if (this.optimisticallyRemovedContainerIds.delete(containerId)) {
            this.render();
        }
    }

    private refreshAfterMutation(): Promise<ContainerSyncResult> {
        return this.sync.refreshAfterMutation
            ? this.sync.refreshAfterMutation()
            : this.sync.refresh();
    }

    private runMutation<T>(operation: () => Promise<T>): Promise<T> {
        return this.sync.runMutation
            ? this.sync.runMutation(operation)
            : operation();
    }

    private markContainerDeleted(containerId: string): void {
        this.sync.markContainerDeleted?.(containerId);
    }

    private clearContainerDeleted(containerId: string): void {
        this.sync.clearContainerDeleted?.(containerId);
    }

    private applyOperationOverlay(container: SyncedContainer): SyncedContainer {
        const operation = this.operationRegistry?.get(container.containerId);
        if (!operation) {
            return container;
        }
        return {
            ...container,
            remote: true,
            status: getContainerOperationStatus(operation.action),
            error: undefined,
        };
    }

    private setWebviewHtml(html: string): void {
        if (!this.webviewView || this.disposed) {
            return;
        }
        if (stripWebviewNonces(this.webviewView.webview.html) === stripWebviewNonces(html)) {
            return;
        }
        this.webviewView.webview.html = html;
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (this.disposed || !isRecord(message) || typeof message.command !== 'string') {
            return;
        }

        const containerId = typeof message.containerId === 'string' ? message.containerId : undefined;
        try {
            switch (message.command) {
                case 'refresh':
                    if (!this.pageReady) {
                        await this.preparePage();
                    } else {
                        await this.sync.refresh();
                    }
                    return;
                case 'openConfig':
                    await this.onOpenConfig?.();
                    return;
                case 'openAdmin':
                    if (this.adminAllowed) {
                        await this.onOpenAdmin?.();
                    }
                    return;
                case 'create':
                    await this.createContainerFromPrompt();
                    return;
                case 'disconnect':
                    if (this.cloudMode) {
                        await this.onDisconnect?.();
                    }
                    return;
                case 'connect':
                    await this.connectContainer(containerId);
                    return;
                case 'openNovnc':
                    await this.openNovncUrl(containerId);
                    return;
                case 'restart':
                    await this.runContainerAction(containerId, 'restart', id => this.publicApi.restartContainer(id));
                    return;
                case 'delete':
                    await this.deleteContainer(containerId);
                    return;
                case 'removeHistory':
                    await this.removeHistory(containerId);
                    return;
                default:
                    return;
            }
        } catch (error) {
            this.showError(error);
        } finally {
            this.completeWebviewAction(message.command, containerId);
        }
    }

    private async connectContainer(containerId: string | undefined): Promise<void> {
        const container = this.findContainer(containerId);
        if (!container || !container.remote) {
            throw new Error('服务已被删除，无法连接');
        }
        if (container.error) {
            throw new Error(`服务 "${container.containerId}" 当前不可连接：${container.error.message}`);
        }
        if ((this.containerOperationCounts.get(container.containerId) ?? 0) > 0 || this.operationRegistry?.has(container.containerId)) {
            throw new Error(`服务 "${container.containerId}" 正在执行操作，暂时无法连接`);
        }
        if (container.status.toLowerCase() !== 'running') {
            throw new Error(`服务 "${container.containerId}" 当前状态为“${getStatusLabel(container)}”，仅运行中的服务可以连接`);
        }
        if (!container.host) {
            throw new Error(`服务 "${container.containerId}" 没有可用的连接端口`);
        }
        await this.onConnect?.(container.host);
    }

    private async openNovncUrl(containerId: string | undefined): Promise<void> {
        const container = this.findContainer(containerId);
        if (!container?.novncUrl) {
            throw new Error('当前服务没有可用的沙箱访问链接');
        }
        const url = container.novncUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
            throw new Error('沙箱访问链接格式无效');
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private async runContainerAction(
        containerId: string | undefined,
        operationAction: ContainerOperationAction,
        action: (containerId: string) => Promise<void>,
    ): Promise<void> {
        const container = this.findContainer(containerId);
        if (!container || !container.remote) {
            throw new Error('服务已被删除，无法执行此操作');
        }
        if (!containerId) {
            throw new Error('缺少容器 ID');
        }
        if (container.status.toLowerCase() === 'failed') {
            throw new Error(`服务 "${container.containerId}" 处于失败状态，不能重启`);
        }
        if ((this.containerOperationCounts.get(container.containerId) ?? 0) > 0 || this.operationRegistry?.has(container.containerId)) {
            throw new Error(`服务 "${container.containerId}" 正在执行操作，请稍后重试`);
        }
        this.claimContainerOperation(containerId, operationAction);
        this.beginContainerOperation(containerId);
        let succeeded = false;
        try {
            await this.runMutation(() => action(containerId));
            await this.refreshAfterMutation();
            succeeded = true;
        } finally {
            this.releaseContainerOperation(containerId, succeeded ? 'succeeded' : 'failed');
            this.endContainerOperation(containerId);
            this.render();
        }
    }

    private async deleteContainer(containerId: string | undefined): Promise<void> {
        if (!containerId) {
            throw new Error('缺少容器 ID');
        }
        const container = this.findContainer(containerId);
        if (!container || !container.remote) {
            throw new Error('服务已被删除，无法执行此操作');
        }
        if ((this.containerOperationCounts.get(container.containerId) ?? 0) > 0 || this.operationRegistry?.has(container.containerId)) {
            throw new Error(`服务 "${container.containerId}" 正在执行操作，请稍后重试`);
        }
        this.claimContainerOperation(containerId, 'delete');
        this.beginContainerOperation(containerId);
        this.markContainerDeleted(containerId);
        this.optimisticallyRemoveContainer(containerId);
        let succeeded = false;
        try {
            await this.runMutation(async () => {
                await this.publicApi.deleteContainer(containerId);
                await this.removeContainerFromConfig(containerId);
            });
            await this.refreshAfterMutation();
            succeeded = true;
        } catch (error) {
            this.clearContainerDeleted(containerId);
            this.restoreOptimisticallyRemovedContainer(containerId);
            throw error;
        } finally {
            this.releaseContainerOperation(containerId, succeeded ? 'succeeded' : 'failed');
            this.endContainerOperation(containerId);
            this.render();
        }
    }

    private async removeHistory(containerId: string | undefined): Promise<void> {
        if (!containerId) {
            throw new Error('缺少容器 ID');
        }
        const removed = await this.runMutation(() => this.removeContainerFromConfig(containerId));
        if (removed) {
            this.optimisticallyRemoveContainer(containerId);
        }
        await this.refreshAfterMutation();
    }

    private async removeContainerFromConfig(containerId: string): Promise<boolean> {
        const document = await this.config.read();
        const removed = this.config.removeContainer(document.config, containerId);
        if (removed) {
            await this.config.write(document);
        }
        return removed;
    }

    private async performCreateContainer(): Promise<void> {
        if (this.cloudMode || !this.safeIsDisconnected()) {
            return;
        }
        if (!this.pageReady) {
            await this.preparePage();
        }
        if (this.pageError || !this.pageReady) {
            if (this.pageError) {
                this.showError(this.pageError.message);
            }
            return;
        }

        const title = '创建新 TestAgent Cloud 服务';
        const giteeInput = await this.showInputBox({
            title,
            prompt: '码云仓库地址 (支持 HTTP 与 GIT 协议，可选)',
            placeHolder: '',
        });
        if (giteeInput === undefined) {
            return;
        }
        const normalizedGiteeInput = giteeInput.trim();
        let normalizedGiteeUser = '';
        let normalizedGiteeRepository = '';
        let normalizedGiteeBranch = '';
        let normalizedGiteeUrl = '';
        if (normalizedGiteeInput) {
            const parsedRepository = parseGiteeRepositoryUrl(normalizedGiteeInput);
            if (!parsedRepository) {
                this.showError('码云仓库地址格式无效');
                return;
            }

            normalizedGiteeUser = parsedRepository.user;
            normalizedGiteeRepository = parsedRepository.repository;
            normalizedGiteeUrl = parsedRepository.url;
            const giteeBranch = await this.showInputBox({
                title,
                prompt: '码云分支 (可选)',
                placeHolder: 'master',
            });
            if (giteeBranch === undefined) {
                return;
            }
            normalizedGiteeBranch = giteeBranch.trim();
        }
        const authorization = await this.showQuickPick(['授权使用 TestAgent 码云通用账户'], {
            title,
            placeHolder: '勾选以使用 TestAgent 码云通用账户执行 git 命令',
            canPickMany: true,
        });
        if (authorization === undefined) {
            return;
        }

        const createdSuccessfully = await vscode.window.withProgress({
            title: '正在创建TestAgent Cloud 服务...',
            location: vscode.ProgressLocation.Notification,
            cancellable: false,
        }, async () => {
            const createdSuccessfully = await this.runMutation(async () => {
                const created = await this.publicApi.createContainer({
                    ...(normalizedGiteeUrl ? { gitee_url: normalizedGiteeUrl } : {}),
                    ...(normalizedGiteeUser ? { gitee_user: normalizedGiteeUser } : {}),
                    ...(normalizedGiteeRepository ? { gitee_repository: normalizedGiteeRepository } : {}),
                    ...(normalizedGiteeBranch ? { gitee_branch: normalizedGiteeBranch } : {}),
                    authorize_general_account: authorization.includes('授权使用 TestAgent 码云通用账户'),
                });
                if (typeof created.container_id !== 'string' || !created.container_id.trim()) {
                    this.showError('响应中缺少有效的 container_id');
                    return false;
                }

                const settings = this.getSettings();
                const userName = getEffectiveRemoteUserName(settings.userName);
                const endpoint = parseContainerEndpoint(created.endpoint, { allowDebugProxy: settings.debug });
                if (!endpoint) {
                    this.showError(`服务 "${created.container_id}" 的 endpoint 无效，应为 IP:Port 格式：${created.endpoint ?? '(空)'}`);
                    return false;
                }

                const document = await this.config.read();
                const existingEntries = this.config.list(document.config)
                    .filter(entry => entry.containerId !== created.container_id);
                const usedNames = new Set(existingEntries.map(entry => entry.host).filter(Boolean));
                const host = getUniqueHostName(
                    getContainerHostName(normalizedGiteeUser, normalizedGiteeRepository),
                    usedNames,
                );
                this.config.upsertContainer(document.config, {
                    containerId: created.container_id,
                    host,
                    hostName: endpoint.host,
                    port: endpoint.port,
                }, {
                    skipKnownHostsCheck: settings.skipKnownHostsCheck,
                    userName,
                });
                await this.config.write(document);
                return true;
            });
            if (createdSuccessfully) {
                await this.refreshAfterMutation();
            }
            return createdSuccessfully;
        });
        if (createdSuccessfully) {
            this.showCreateSuccess();
        }
    }

    private findContainer(containerId: string | undefined): SyncedContainer | undefined {
        if (!containerId) {
            return undefined;
        }
        if (this.optimisticallyRemovedContainerIds.has(containerId)) {
            return undefined;
        }
        return this.state.getState().containers.find(container => container.containerId === containerId);
    }

    private beginContainerOperation(containerId: string): void {
        this.containerOperationCounts.set(containerId, (this.containerOperationCounts.get(containerId) ?? 0) + 1);
        this.render();
    }

    private claimContainerOperation(containerId: string, action: ContainerOperationAction): void {
        if (this.operationRegistry && !this.operationRegistry.begin(containerId, action, 'sidebar')) {
            throw new Error(`服务 "${containerId}" 正在执行操作，请稍后重试`);
        }
    }

    private releaseContainerOperation(containerId: string, outcome: ContainerOperationOutcome): void {
        this.operationRegistry?.complete(containerId, outcome);
    }

    private endContainerOperation(containerId: string): void {
        const count = this.containerOperationCounts.get(containerId) ?? 0;
        if (count <= 1) {
            this.containerOperationCounts.delete(containerId);
        } else {
            this.containerOperationCounts.set(containerId, count - 1);
        }
    }

    private safeIsDisconnected(): boolean {
        try {
            return this.isDisconnected();
        } catch {
            return false;
        }
    }

    private showError(error: unknown): void {
        const message = formatRestClientError(error);
        void vscode.window.showErrorMessage(message, { modal: true });
    }

    private showCreateSuccess(): void {
        void vscode.window.showInformationMessage('TestAgent Cloud 服务创建成功');
    }

    private completeWebviewAction(action: string, containerId: string | undefined): void {
        this.postWebviewMessage({
            command: 'operationComplete',
            action,
            ...(containerId ? { containerId } : {}),
        });
    }

    private postWebviewMessage(message: unknown): boolean {
        const webview = this.webviewView?.webview;
        if (!webview || typeof webview.postMessage !== 'function') {
            return false;
        }
        try {
            void webview.postMessage(message);
            return true;
        } catch {
            return false;
        }
    }
}

type SidebarIcon = 'admin' | 'close' | 'config' | 'connect' | 'cloud' | 'delete' | 'disconnect' | 'external' | 'refresh' | 'restart' | 'warning';

const SIDEBAR_ICONS: Record<SidebarIcon, string> = {
    admin: '<path d="M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="M18.5 3.5v3M17 5h3"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    config: '<path d="M3.5 7.5h6l1.5 2h9.5v8.75a1.25 1.25 0 0 1-1.25 1.25H4.75a1.25 1.25 0 0 1-1.25-1.25Z"/><path d="M3.5 7.5V6.25A1.25 1.25 0 0 1 4.75 5h4l1.5 2"/>',
    connect: '<path d="M8.5 15.5 15.5 8.5"/><path d="M6.25 12.75 4.5 14.5a3.18 3.18 0 0 0 4.5 4.5l1.75-1.75"/><path d="m13.25 6.75 1.75-1.75a3.18 3.18 0 0 1 4.5 4.5l-1.75 1.75"/>',
    cloud: '<path d="M7.5 18.5h9a4 4 0 0 0 .7-7.94A5.5 5.5 0 0 0 6.58 9.1 3.75 3.75 0 0 0 7.5 18.5Z"/>',
    delete: '<path d="M5 7h14M9 7V5h6v2M7 7l.8 12h8.4L17 7M10 10.5v5M14 10.5v5"/>',
    disconnect: '<path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H9M13 15l4-4-4-4M17 11H9"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M5 4v4h4M4 13a8 8 0 0 0 14.9 3M19 20v-4h-4"/>',
    restart: '<path d="M20 11a8 8 0 0 0-14.9-3M5 4v4h4M4 13a8 8 0 0 0 14.9 3"/><path d="M19 16v4h-4"/>',
    warning: '<path d="m12 4 8 15H4Z"/><path d="M12 9v4M12 16h.01"/>',
};

function renderIcon(icon: SidebarIcon): string {
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SIDEBAR_ICONS[icon]}</svg>`;
}

function renderSidebarHtml(
    containers: SyncedContainer[],
    showAdmin: boolean,
    inFlightContainerIds: ReadonlySet<string>,
): string {
    const cards = containers.length
        ? containers.map(container => renderContainerCard(container, inFlightContainerIds.has(container.containerId))).join('')
        : `<div class="empty-state">
                ${renderIcon('cloud')}
                <strong>还没有 TestAgent Cloud 服务</strong>
                <span>请使用 测小智TestAgent 插件进行创建</span>
            </div>`;
    const adminButton = showAdmin ? renderToolbarButton('openAdmin', '打开管理员页面', 'admin') : '';
    const configButton = showAdmin ? renderToolbarButton('openConfig', '打开配置文件', 'config') : '';
    return renderDocument(`
        <main class="sidebar">
            <header class="app-bar">
                <h1 class="page-title">TestAgent Cloud 服务管理面板</h1>
                <div class="toolbar-actions" role="toolbar">
                    ${adminButton}
                    ${configButton}
                    ${renderToolbarButton('refresh', '刷新页面', 'refresh')}
                </div>
            </header>
            <section class="container-list">${cards}</section>
        </main>
    `);
}

function renderToolbarButton(action: string, label: string, icon: SidebarIcon): string {
    return `<button class="icon-button" data-action="${action}" title="${escapeHtml(label)}">${renderIcon(icon)}</button>`;
}

function renderContainerCard(container: SyncedContainer, operationInFlight: boolean): string {
    const statusClass = getStatusClass(container);
    const statusLabel = getStatusLabel(container);
    const usage = renderUsage(container);
    const expiration = renderExpirationStatus(container);
    const typeBadge = renderTypeBadge(container.containerType);
    const sandboxAccess = renderSandboxAccess(container);
    const containerId = escapeHtml(container.containerId);
    const host = escapeHtml(container.host || '未配置 Host');
    const canOperate = container.remote;
    const canConnect = canOperate
        && container.status.toLowerCase() === 'running'
        && !container.error
        && !!container.host
        && !operationInFlight;
    const disabledOperation = canOperate && !operationInFlight ? '' : ' disabled';
    const disabledRestart = canOperate && container.status.toLowerCase() !== 'failed' && !operationInFlight ? '' : ' disabled';
    const disabledConnect = canConnect ? '' : ' disabled';
    const error = container.error
        ? `<div class="card-error">${escapeHtml(container.error.message)}</div>`
        : '';
    const history = !container.remote && container.expiresAt
        ? `<div class="history-warning">
                <span>${renderIcon('warning')}此服务已过期并被资源回收，请手动删除此本地条目</span>
                <button class="history-remove" data-action="removeHistory" data-container-id="${containerId}" title="从本地条目中删除">${renderIcon('close')}</button>
            </div>`
        : '';
    return `
        <article class="container-card" data-container-id="${containerId}" data-connectable="${canConnect ? 'true' : 'false'}">
            <div class="service-heading" data-container-id="${containerId}" data-connectable="${canConnect ? 'true' : 'false'}">
                <strong class="service-name">${host}</strong>
                <div class="service-status">
                    ${typeBadge}
                    <span class="status-dot ${statusClass}"></span>
                    <span class="status-label">${escapeHtml(statusLabel)}</span>
                    ${usage}
                </div>
            </div>
            ${error}
            <div class="card-actions">
                <button class="action-button action-primary" data-action="connect" data-container-id="${containerId}" data-connectable="${canConnect ? 'true' : 'false'}"${disabledConnect}>${renderIcon('connect')}连接</button>
                <button class="action-button" data-action="restart" data-container-id="${containerId}"${disabledRestart}>${renderIcon('restart')}重启</button>
                <button class="action-button" data-action="delete" data-container-id="${containerId}"${disabledOperation}>${renderIcon('delete')}销毁</button>
            </div>
            ${sandboxAccess}
            ${expiration}
            ${history}
        </article>
    `;
}

function renderTypeBadge(containerType: string | null | undefined): string {
    if (!containerType) {
        return '';
    }
    let label: string;
    let variant: string;
    switch (containerType) {
        case 'testagent_cloud':
            label = 'TestAgentCloud';
            variant = 'testagent';
            break;
        case 'autotest_cloud':
            label = '自动化跑批';
            variant = 'autotest';
            break;
        default:
            label = containerType;
            variant = 'unknown';
    }
    return `<span class="type-badge type-badge-${variant}" title="${escapeHtml(containerType)}">${escapeHtml(label)}</span>`;
}

function renderSandboxAccess(container: SyncedContainer): string {
    if (!container.remote || !container.novncUrl) {
        return '';
    }
    return `
        <div class="sandbox-access-row">
            <button class="sandbox-access-link" data-action="openNovnc" data-container-id="${escapeHtml(container.containerId)}" title="在浏览器中打开沙箱可视化访问链接">
                ${renderIcon('external')}沙箱访问
            </button>
        </div>
    `;
}

function renderCloudHtml(): string {
    return renderDocument(`
        <main class="cloud-card">
            <div class="cloud-icon" aria-hidden="true">${renderIcon('cloud')}</div>
            <h1>当前已连接至 TestAgent Cloud 服务中</h1>
            <p>所有改动均只在 TestAgent Cloud 服务内生效！</p>
            <button class="action-button action-primary" data-action="disconnect">${renderIcon('disconnect')}断开连接</button>
        </main>
    `);
}

function renderErrorHtml(message: string): string {
    return renderDocument(`<main class="error-page">${renderIcon('warning')}<span class="section-kicker">请联系支持团队处理</span><p>${escapeHtml(message)}</p></main>`);
}

function renderLoadingHtml(): string {
    return renderDocument('<main class="loading"><span class="loading-indicator"></span><p>正在加载 TestAgent Cloud 服务...</p></main>');
}

function renderUsage(container: SyncedContainer): string {
    return [
        '<span class="usage-separator" aria-hidden="true">&middot;</span>',
        renderUsageMetric('CPU占用率', container.cpuUsage),
        '<span class="usage-separator" aria-hidden="true">&middot;</span>',
        renderUsageMetric('内存使用率', container.memoryUsage),
    ].join('');
}

function renderUsageMetric(label: string, value: number | null | undefined): string {
    return `<span class="usage-metric ${getUsageClass(value)}">${label} ${formatUsage(value)}</span>`;
}

function formatUsage(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--';
}

function getUsageClass(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'usage-metric-unavailable';
    }
    if (value >= 90) {
        return 'usage-metric-critical';
    }
    if (value >= 75) {
        return 'usage-metric-warning';
    }
    return 'usage-metric-low';
}

function renderExpirationStatus(container: SyncedContainer): string {
    if (!container.remote || container.status === 'missing' || !container.expiresAt) {
        return '';
    }

    const expiration = getExpirationDisplay(container.expiresAt);
    return expiration
        ? `<div class="expiration-status ${expiration.className}">${escapeHtml(expiration.label)}</div>`
        : '';
}

interface ExpirationDisplay {
    label: string;
    className: 'warning' | 'critical';
}

function getExpirationDisplay(expiresAt: string, now = Date.now()): ExpirationDisplay | undefined {
    const expirationTime = Date.parse(expiresAt);
    if (Number.isNaN(expirationTime)) {
        return undefined;
    }

    const remainingMs = expirationTime - now;
    if (remainingMs <= 0) {
        return { label: '已过期', className: 'critical' };
    }

    const totalMinutes = Math.floor(remainingMs / 60_000);
    const days = Math.floor(totalMinutes / 1_440);
    const hours = Math.floor((totalMinutes % 1_440) / 60);
    const minutes = totalMinutes % 60;
    return {
        label: `服务剩余时间: ${days}天 ${hours}小时 ${minutes}分钟`,
        className: remainingMs <= 3_600_000 ? 'critical' : 'warning',
    };
}

function renderDocument(body: string): string {
    const nonce = randomBytes(16).toString('hex');
    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            color-scheme: light dark;
            --vscode-foreground: #d6d6dd;
            --vscode-sideBar-background: #17171c;
            --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            --vscode-font-size: 13px;
            --vscode-button-foreground: #ffffff;
            --vscode-textLink-foreground: #8ab4f8;
            --vscode-panel-border: #3a3a45;
            --vscode-sideBarSectionHeader-background: #24242d;
            --vscode-focusBorder: #8ab4f8;
            --vscode-descriptionForeground: #a7a7b0;
            --vscode-charts-yellow: #e5c07b;
            --vscode-testing-iconPassed: #81c995;
            --vscode-testing-iconFailed: #f28b82;
            --vscode-editorWarning-foreground: #e5c07b;
            --vscode-errorForeground: #f28b82;
            --surface: var(--vscode-sideBar-background, #fdf8ff);
            --surface-container: var(--vscode-sideBarSectionHeader-background, #f5eff7);
            --surface-container-high: var(--vscode-sideBarSectionHeader-background, #ece6ee);
            --on-surface: var(--vscode-foreground, #211a20);
            --on-surface-variant: var(--vscode-descriptionForeground, #4b454d);
            --primary: var(--vscode-textLink-foreground, #6750a4);
            --on-primary: var(--vscode-button-foreground, #ffffff);
            --outline: var(--vscode-panel-border, #79747e);
            --error: var(--vscode-errorForeground, #ba1a1a);
            --warning: var(--vscode-editorWarning-foreground, #8b6914);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 16px 14px 24px;
            color: var(--on-surface);
            background: var(--surface);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif), sans-serif;
            font-size: var(--vscode-font-size);
            line-height: 1.45;
        }
        button {
            min-height: 34px;
            border: 1px solid transparent;
            border-radius: 10px;
            padding: 0 14px;
            color: var(--on-surface);
            background: var(--surface-container-high);
            font: inherit;
            cursor: pointer;
            transition: background .16s ease, border-color .16s ease, transform .16s ease;
        }
        button:hover { border-color: var(--outline); background: var(--surface-container); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
        button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .icon { width: 18px; height: 18px; flex: 0 0 18px; }
        .sidebar { width: 100%; max-width: none; margin: 0; }
        .app-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
        .page-title { min-width: 0; margin: 0; overflow: hidden; color: var(--on-surface); font-size: 17px; font-weight: 700; letter-spacing: -.02em; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
        .section-kicker { display: block; color: var(--on-surface-variant); font-size: 10px; font-weight: 700; letter-spacing: .14em; line-height: 1.2; }
        .toolbar-actions { display: flex; align-items: center; gap: 1px; flex: 0 0 auto; padding: 2px; border: 1px solid var(--outline); border-radius: 12px; background: var(--surface-container); }
        .icon-button { width: 32px; height: 32px; min-height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; color: var(--on-surface-variant); background: transparent; }
        .icon-button:hover { border: 0; color: var(--on-surface); background: var(--surface-container-high); }
        .container-list { display: flex; flex-direction: column; gap: 12px; }
        .container-card { padding: 16px; border: 1px solid var(--outline); border-radius: 12px; background: var(--surface-container); box-shadow: 0 3px 10px rgba(0, 0, 0, .14); }
        .container-card:hover { border-color: var(--vscode-focusBorder); }
        .service-heading { min-width: 0; }
        .service-name { display: block; min-width: 0; overflow-wrap: anywhere; font-size: 15px; }
        .service-status { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin: 7px 0 0; color: var(--on-surface-variant); font-size: 12px; }
        .status-label { white-space: nowrap; }
        .status-dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--vscode-charts-yellow); }
        .status-dot.running { background: var(--vscode-testing-iconPassed, #3fb950); }
         .status-dot.stopped, .status-dot.failed, .status-dot.error { background: var(--vscode-testing-iconFailed, #f14c4c); }
         .status-dot.pending { background: var(--vscode-charts-yellow, #e5c07b); animation: status-pulse 1.2s ease-in-out infinite; }
        .status-dot.missing { background: var(--vscode-descriptionForeground); }
        .usage-separator { color: var(--on-surface-variant); font-weight: 700; }
        .usage-metric { white-space: nowrap; }
        .usage-metric-low { color: var(--vscode-testing-iconPassed, #3fb950); }
        .usage-metric-warning { color: var(--vscode-editorWarning-foreground, #e5c07b); }
        .usage-metric-critical { color: var(--vscode-errorForeground, #f28b82); }
        .usage-metric-unavailable { color: var(--on-surface); }
        .type-badge { padding: 1px 7px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; line-height: 1.5; white-space: nowrap; }
        .type-badge-testagent { color: var(--vscode-textLink-foreground, #8ab4f8); }
        .type-badge-autotest { color: var(--vscode-charts-yellow, #e5c07b); }
        .type-badge-unknown { color: var(--on-surface-variant); }
        .sandbox-access-row { display: flex; align-items: center; justify-content: center; margin-top: 12px; }
        .sandbox-access-link { min-height: auto; display: inline-flex; align-items: center; gap: 6px; padding: 1px 4px; border: 0; border-radius: 4px; color: var(--primary); background: transparent; text-decoration: underline; cursor: pointer; }
        .sandbox-access-link:hover { border: 0; color: var(--primary); background: transparent; opacity: .85; text-decoration: none; }
        .sandbox-access-link .icon { width: 15px; height: 15px; }
        .expiration-status { margin-top: 16px; color: var(--warning); font-size: 12px; }
        .expiration-status.critical { color: var(--error); }
        .card-error { margin: 13px 0 0; padding: 9px 11px; border-radius: 8px; color: var(--error); background: var(--surface-container-high); overflow-wrap: anywhere; }
        .card-actions { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
        .action-button { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 7px; border-color: var(--outline); }
        .action-button .icon { width: 16px; height: 16px; }
        .action-primary { border-color: var(--outline); color: var(--on-primary); background: var(--primary); }
        .action-primary:hover { border-color: var(--outline); color: var(--on-primary); background: var(--primary); opacity: .9; }
        button.is-loading { pointer-events: none; color: transparent; opacity: .8; }
        button.is-loading .icon { visibility: hidden; }
        button.is-loading::after { content: ''; position: absolute; width: 14px; height: 14px; border: 2px solid var(--on-surface); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
        button.action-primary.is-loading::after { border-color: var(--on-primary); border-top-color: transparent; }
        button.icon-button.is-loading::after { border-color: var(--on-surface-variant); border-top-color: transparent; }
        .history-warning { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; padding: 8px 10px; border-radius: 8px; color: var(--warning); background: var(--surface-container-high); font-size: 12px; }
        .history-warning > span { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .history-warning .icon { width: 15px; height: 15px; }
        .history-remove { width: 26px; min-height: 26px; display: grid; place-items: center; flex: 0 0 26px; padding: 0; border: 0; border-radius: 50%; color: var(--error); background: transparent; }
        .history-remove:hover { border: 0; color: var(--error); background: var(--surface-container-high); }
        .history-remove .icon { width: 15px; height: 15px; }
        .empty-state, .loading, .cloud-card { text-align: center; }
        .empty-state { display: flex; align-items: center; flex-direction: column; gap: 5px; padding: 38px 18px; border: 1px dashed var(--outline); border-radius: 12px; color: var(--on-surface-variant); }
        .empty-state .icon { width: 30px; height: 30px; margin-bottom: 7px; color: var(--primary); }
        .empty-state strong { color: var(--on-surface); font-size: 14px; }
        .cloud-card { min-height: 270px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 30px 20px; border: 2px solid var(--warning); border-radius: 16px; background: var(--surface-container); box-shadow: 0 5px 16px rgba(0, 0, 0, .16); }
        .cloud-icon { width: 64px; height: 64px; display: grid; place-items: center; margin-bottom: 5px; border-radius: 12px; color: var(--warning); background: var(--surface-container-high); }
        .cloud-icon .icon { width: 34px; height: 34px; }
        .cloud-card h1 { max-width: 270px; font-size: 18px; }
        .cloud-card p { margin: 0 0 8px; color: var(--warning); font-weight: 600; text-align: center; }
        .cloud-card .action-button { width: 100%; max-width: 160px; max-height: 28px; padding: 0 12px; }
        .error-page { min-height: calc(100vh - 40px); display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; padding: 30px 20px; color: var(--error); text-align: center; }
        .error-page > .icon { width: 32px; height: 32px; }
        .error-page p { max-width: 100%; margin: 0; overflow-wrap: anywhere; }
        .loading { min-height: 180px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: var(--on-surface-variant); }
        .loading-indicator { width: 24px; height: 24px; border: 3px solid var(--surface-container-high); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
         @keyframes spin { to { transform: rotate(360deg); } }
         @keyframes status-pulse { 50% { opacity: .35; transform: scale(.72); } }
        @media (max-width: 360px) {
            body { padding: 12px 10px 20px; }
            .app-bar { gap: 7px; margin-bottom: 12px; }
            .page-title { font-size: 15px; }
            .toolbar-actions { gap: 0; }
            .icon-button { width: 30px; height: 30px; min-height: 30px; }
            .container-card { padding: 14px; }
            .action-button { flex: 1 1 90px; }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
        }
    </style>
</head>
<body>
${body}
<script nonce="${nonce}">${WEBVIEW_SCRIPT}</script>
</body>
</html>`;
}

function stripWebviewNonces(html: string): string {
    return html
        .replace(/nonce="[^"]*"/g, 'nonce=""')
        .replace(/nonce-[^']*/g, 'nonce-');
}

function getStatusClass(container: SyncedContainer): string {
    if (container.error) {
        return container.status.toLowerCase() === 'unknown' ? 'unknown error' : 'error';
    }
    if (!container.remote || container.status === 'missing') {
        return 'missing';
    }
    if (container.status.toLowerCase() === 'running') {
        return 'running';
    }
    if (container.status.toLowerCase() === 'stopped') {
        return 'stopped';
    }
    if (container.status.toLowerCase() === 'failed') {
        return 'failed';
    }
    if (['pending', 'starting', 'stopping', 'restarting', 'deleting', 'restoring'].includes(container.status.toLowerCase())) {
        return 'pending';
    }
    return 'unknown';
}

function getStatusLabel(container: SyncedContainer): string {
    if (!container.remote || container.status === 'missing') {
        return '已过期';
    }
    switch (container.status.toLowerCase()) {
        case 'running':
            return '运行中';
        case 'stopped':
            return '已停止';
        case 'failed':
            return '已失败';
        case 'starting':
            return '启动中';
        case 'stopping':
            return '停止中';
        case 'restarting':
            return '重启中';
        case 'deleting':
            return '操作中';
        case 'restoring':
            return '操作中';
        case 'pending':
            return '准备中';
        default:
            return container.status || '未知';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSidebarError(error: unknown, fallbackCode: string, fallbackMessage: string): ContainerSyncError {
    if (error instanceof Error && error.message) {
        return { code: fallbackCode, message: error.message };
    }
    return { code: fallbackCode, message: fallbackMessage };
}

function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
