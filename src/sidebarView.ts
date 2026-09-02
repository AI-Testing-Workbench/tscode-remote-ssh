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
import { parseContainerEndpoint } from './containerEndpoint';
import { getRemoteSettings, type RemoteSettings } from './settings';
import { UserIdProvider } from './user';
import { type PublicUserContainerApi } from './api/publicApi';
import { type UserRestApi } from './api/restClient';

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
    sync: Pick<ContainerSync, 'refresh'>;
    config: ContainerConfig;
    publicApi: PublicUserContainerApi;
    userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    userApiFactory: (baseUrl: string) => UserRestApi;
    getSettings?: () => RemoteSettings;
    cloudMode?: boolean;
    isDisconnected?: () => boolean;
    onOpenConfig?: () => void | Promise<void>;
    onOpenAdmin?: () => void | Promise<void>;
    onConnect?: (host: string) => void | Promise<void>;
    onDisconnect?: () => void | Promise<void>;
    showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick?: (
        items: readonly string[],
        options: vscode.QuickPickOptions & { canPickMany: true },
    ) => Thenable<string[] | undefined>;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly state: SidebarSyncState;
    private readonly sync: Pick<ContainerSync, 'refresh'>;
    private readonly config: ContainerConfig;
    private readonly publicApi: PublicUserContainerApi;
    private readonly userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    private readonly userApiFactory: (baseUrl: string) => UserRestApi;
    private readonly getSettings: () => RemoteSettings;
    private readonly cloudMode: boolean;
    private readonly isDisconnected: () => boolean;
    private readonly onOpenConfig: (() => void | Promise<void>) | undefined;
    private readonly onOpenAdmin: (() => void | Promise<void>) | undefined;
    private readonly onConnect: ((host: string) => void | Promise<void>) | undefined;
    private readonly onDisconnect: (() => void | Promise<void>) | undefined;
    private readonly showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    private readonly showQuickPick: (
        items: readonly string[],
        options: vscode.QuickPickOptions & { canPickMany: true },
    ) => Thenable<string[] | undefined>;
    private readonly stateSubscription: { dispose: () => void };

    private webviewView: vscode.WebviewView | undefined;
    private messageSubscription: vscode.Disposable | undefined;
    private viewDisposeSubscription: vscode.Disposable | undefined;
    private adminCheckInFlight: Promise<void> | undefined;
    private createInFlight: Promise<void> | undefined;
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
        this.isDisconnected = options.isDisconnected ?? (() => !vscode.env.remoteName);
        this.onOpenConfig = options.onOpenConfig;
        this.onOpenAdmin = options.onOpenAdmin;
        this.onConnect = options.onConnect;
        this.onDisconnect = options.onDisconnect;
        this.showInputBox = options.showInputBox ?? (inputOptions => vscode.window.showInputBox(inputOptions));
        this.showQuickPick = options.showQuickPick ?? ((items, quickPickOptions) => vscode.window.showQuickPick(items, quickPickOptions));
        this.stateSubscription = this.state.subscribe(() => this.render());
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): Thenable<void> {
        if (this.disposed) {
            return Promise.resolve();
        }

        this.messageSubscription?.dispose();
        this.viewDisposeSubscription?.dispose();
        this.webviewView = webviewView;
        this.pageReady = false;
        this.pageError = undefined;
        this.adminAllowed = false;

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
            this.messageSubscription = undefined;
            this.viewDisposeSubscription = undefined;
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

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.stateSubscription.dispose();
        this.messageSubscription?.dispose();
        this.viewDisposeSubscription?.dispose();
        this.messageSubscription = undefined;
        this.viewDisposeSubscription = undefined;
        this.webviewView = undefined;
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
            this.webviewView.webview.html = renderCloudHtml();
            return;
        }

        const result = this.state.getState();
        const error = this.pageError ?? result.error;
        if (error) {
            this.webviewView.webview.html = renderErrorHtml(error.message);
            return;
        }
        if (!this.pageReady) {
            this.webviewView.webview.html = renderLoadingHtml();
            return;
        }

        this.webviewView.webview.html = renderSidebarHtml(
            result.containers,
            this.adminAllowed,
            this.safeIsDisconnected(),
        );
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
                case 'restart':
                    await this.runContainerAction(containerId, id => this.publicApi.restartContainer(id));
                    return;
                case 'delete':
                    await this.runContainerAction(containerId, id => this.publicApi.deleteContainer(id));
                    return;
                case 'removeHistory':
                    await this.removeHistory(containerId);
                    return;
                default:
                    return;
            }
        } catch (error) {
            this.showError(error);
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
        if (!container.host) {
            throw new Error(`服务 "${container.containerId}" 没有可用的连接端口`);
        }
        await this.onConnect?.(container.host);
    }

    private async runContainerAction(
        containerId: string | undefined,
        action: (containerId: string) => Promise<void>,
    ): Promise<void> {
        const container = this.findContainer(containerId);
        if (!container || !container.remote) {
            throw new Error('服务已被删除，无法执行此操作');
        }
        if (!containerId) {
            throw new Error('缺少容器 ID');
        }
        await action(containerId);
        await this.sync.refresh();
    }

    private async removeHistory(containerId: string | undefined): Promise<void> {
        if (!containerId) {
            throw new Error('缺少容器 ID');
        }
        const document = await this.config.read();
        if (this.config.removeContainer(document.config, containerId)) {
            await this.config.write(document);
        }
        await this.sync.refresh();
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
        const giteeUser = await this.showInputBox({
            title,
            prompt: '码云用户名',
            placeHolder: '',
        });
        if (giteeUser === undefined) {
            return;
        }
        const giteeRepository = await this.showInputBox({
            title,
            prompt: '码云仓库名',
            placeHolder: '',
        });
        if (giteeRepository === undefined) {
            return;
        }
        const giteeBranch = await this.showInputBox({
            title,
            prompt: '码云分支 (可选)',
            placeHolder: '留空表示使用码云仓库的默认分支',
        });
        if (giteeBranch === undefined) {
            return;
        }
        const authorization = await this.showQuickPick(['授权使用 TestAgent 码云通用账户'], {
            title,
            placeHolder: '勾选以使用 TestAgent 码云通用账户执行 git 命令',
            canPickMany: true,
        });
        if (authorization === undefined) {
            return;
        }

        const created = await this.publicApi.createContainer({
            ...(giteeUser.trim() ? { gitee_user: giteeUser.trim() } : {}),
            ...(giteeRepository.trim() ? { gitee_repository: giteeRepository.trim() } : {}),
            ...(giteeBranch.trim() ? { gitee_branch: giteeBranch.trim() } : {}),
            authorize_general_account: authorization.includes('授权使用 TestAgent 码云通用账户'),
        });
        if (typeof created.container_id !== 'string' || !created.container_id.trim()) {
            this.showError('响应中缺少有效的 container_id');
            return;
        }

        const settings = this.getSettings();
        const endpoint = parseContainerEndpoint(created.endpoint, { allowDebugProxy: settings.debug });
        if (!endpoint) {
            this.showError(`TestAgent Cloud 服务 "${created.container_id}" 的 endpoint 无效，应为 IP:Port 格式：${created.endpoint ?? '(空)'}`);
            return;
        }

        const document = await this.config.read();
        const existingEntries = this.config.list(document.config)
            .filter(entry => entry.containerId !== created.container_id);
        const usedNames = new Set(existingEntries.map(entry => entry.host).filter(Boolean));
        const host = getUniqueHostName(
            getContainerHostName(giteeUser, giteeRepository),
            usedNames,
        );
        this.config.upsertContainer(document.config, {
            containerId: created.container_id,
            host,
            hostName: endpoint.host,
            port: endpoint.port,
        }, { skipKnownHostsCheck: settings.skipKnownHostsCheck });
        await this.config.write(document);
        await this.sync.refresh();
    }

    private findContainer(containerId: string | undefined): SyncedContainer | undefined {
        if (!containerId) {
            return undefined;
        }
        return this.state.getState().containers.find(container => container.containerId === containerId);
    }

    private safeIsDisconnected(): boolean {
        try {
            return this.isDisconnected();
        } catch {
            return false;
        }
    }

    private showError(error: unknown): void {
        const message = typeof error === 'string'
            ? error
            : error instanceof Error && error.message
                ? error.message
                : 'TestAgent Cloud 服务操作失败';
        void vscode.window.showErrorMessage(message, { modal: true });
    }
}

function renderSidebarHtml(containers: SyncedContainer[], showAdmin: boolean, disconnected: boolean): string {
    const cards = containers.length
        ? containers.map(renderContainerCard).join('')
        : '<div class="empty-state">当前没有可用的 TestAgent Cloud 服务</div>';
    const adminButton = showAdmin ? '<button data-action="openAdmin">管理员页面</button>' : '';
    const createButton = disconnected ? '<button data-action="create">创建 TestAgent Cloud 服务</button>' : '';
    return renderDocument(`
        <main class="sidebar">
            <header class="toolbar">
                <div class="toolbar-actions">
                    <button data-action="refresh" title="刷新 TestAgent Cloud 服务状态">刷新</button>
                    ${adminButton}
                    ${createButton}
                    <button data-action="openConfig">打开 config</button>
                </div>
            </header>
            <section class="container-list" aria-label="TestAgent Cloud 服务列表">${cards}</section>
        </main>
    `);
}

function renderContainerCard(container: SyncedContainer): string {
    const statusClass = getStatusClass(container);
    const statusLabel = getStatusLabel(container);
    const containerId = escapeHtml(container.containerId);
    const host = escapeHtml(container.host || '未配置 Host');
    const endpoint = container.endpoint ? `<span class="endpoint">${escapeHtml(container.endpoint)}</span>` : '';
    const canOperate = container.remote;
    const canConnect = canOperate && !container.error && !!container.host;
    const disabledOperation = canOperate ? '' : ' disabled';
    const disabledConnect = canConnect ? '' : ' disabled';
    const error = container.error
        ? `<div class="card-error">${escapeHtml(container.error.message)}</div>`
        : '';
    const history = container.expiresAt
        ? `<div class="history-warning">TestAgent Cloud 服务已在云端删除 <button class="history-remove" data-action="removeHistory" data-container-id="${containerId}" title="删除本地配置">X</button></div>`
        : '';
    return `
        <article class="container-card" data-container-id="${containerId}">
            <div class="container-heading">
                <span class="status-dot ${statusClass}" aria-label="${escapeHtml(statusLabel)}"></span>
                <strong>${host}</strong>
                <span class="status-label">${escapeHtml(statusLabel)}</span>
            </div>
            ${endpoint ? `<div class="container-meta">${endpoint}</div>` : ''}
            ${error}
            <div class="card-actions secondary-actions">
                <button data-action="restart" data-container-id="${containerId}"${disabledOperation}>重启</button>
                <button data-action="delete" data-container-id="${containerId}"${disabledOperation}>删除</button>
            </div>
            <div class="card-actions primary-actions">
                <button data-action="connect" data-container-id="${containerId}"${disabledConnect}>连接</button>
            </div>
            ${history}
        </article>
    `;
}

function renderCloudHtml(): string {
    return renderDocument(`
        <main class="cloud-card">
            <p>你现在处于 TestAgent Cloud 服务中</p>
            <button data-action="disconnect">断开远程连接</button>
        </main>
    `);
}

function renderErrorHtml(message: string): string {
    return renderDocument(`<main class="error-page"><p>${escapeHtml(message)}</p></main>`);
}

function renderLoadingHtml(): string {
    return renderDocument('<main class="loading"><p>正在加载 TestAgent Cloud 服务...</p></main>');
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
            --vscode-foreground: #cccccc;
            --vscode-sideBar-background: #181818;
            --vscode-font-family: sans-serif;
            --vscode-font-size: 13px;
            --vscode-button-border: transparent;
            --vscode-button-foreground: #ffffff;
            --vscode-button-background: #0e639c;
            --vscode-button-hoverBackground: #1177bb;
            --vscode-panel-border: #3f3f46;
            --vscode-sideBarSectionHeader-background: #252526;
            --vscode-focusBorder: #007fd4;
            --vscode-descriptionForeground: #9d9d9d;
            --vscode-charts-yellow: #cca700;
            --vscode-testing-iconPassed: #73c991;
            --vscode-testing-iconFailed: #f14c4c;
            --vscode-editorWarning-foreground: #cca700;
            --vscode-errorForeground: #f48771;
        }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-family); font-size: var(--vscode-font-size); }
        button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 4px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: .5; cursor: not-allowed; }
        .toolbar { margin-bottom: 10px; }
        .toolbar-actions, .card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .container-list { display: flex; flex-direction: column; gap: 8px; }
        .container-card { padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-sideBarSectionHeader-background); }
        .container-card:hover { border-color: var(--vscode-focusBorder); }
        .container-heading { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 1.08em; }
        .container-heading strong { overflow-wrap: anywhere; }
        .status-label { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: .85em; white-space: nowrap; }
        .status-dot { width: 9px; height: 9px; flex: 0 0 9px; border-radius: 50%; background: var(--vscode-charts-yellow); }
        .status-dot.running { background: var(--vscode-testing-iconPassed, #3fb950); }
        .status-dot.stopped { background: var(--vscode-testing-iconFailed, #f14c4c); }
        .status-dot.missing { background: var(--vscode-descriptionForeground); }
        .container-meta { margin: 7px 0; color: var(--vscode-descriptionForeground); font-size: .86em; overflow-wrap: anywhere; }
        .card-error { margin: 7px 0; color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
        .secondary-actions { margin-top: 8px; }
        .primary-actions { margin-top: 7px; }
        .primary-actions button { width: 100%; }
        .history-warning { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); font-size: .88em; }
        .history-remove { min-width: 24px; padding: 2px 6px; color: var(--vscode-errorForeground); background: transparent; }
        .empty-state, .loading, .cloud-card, .error-page { color: var(--vscode-descriptionForeground); text-align: center; }
        .cloud-card, .error-page { min-height: 180px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
        .error-page { color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
        .error-page p { max-width: 100%; }
    </style>
</head>
<body>
${body}
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const post = (command, containerId) => vscode.postMessage({ command, containerId });
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
        if (!target || target.hasAttribute('disabled')) return;
        post(target.dataset.action, target.dataset.containerId);
    });
    document.addEventListener('dblclick', event => {
        const target = event.target instanceof Element ? event.target : null;
        const card = target?.closest('.container-card');
        if (!card || target?.closest('button')) return;
        post('connect', card.dataset.containerId);
    });
</script>
</body>
</html>`;
}

function getStatusClass(container: SyncedContainer): string {
    if (!container.remote || container.status === 'missing') {
        return 'missing';
    }
    if (container.error) {
        return 'unknown';
    }
    if (container.status.toLowerCase() === 'running') {
        return 'running';
    }
    if (container.status.toLowerCase() === 'stopped') {
        return 'stopped';
    }
    return 'unknown';
}

function getStatusLabel(container: SyncedContainer): string {
    if (!container.remote || container.status === 'missing') {
        return 'TestAgent Cloud 服务已在云端删除';
    }
    switch (container.status.toLowerCase()) {
        case 'running':
            return '运行中';
        case 'stopped':
            return '已停止';
        default:
            return container.status || '未知状态';
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
