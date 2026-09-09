import { ContainerConfig, ContainerConfigEntry } from './containerConfig';
import { RestClientError, UserRestApi } from './api/restClient';
import { ContainerIdsResponse, ContainerStatusResponse } from './api/models';
import {
    InvalidContainerEndpoint,
    parseContainerEndpoint,
    ParsedContainerEndpoint,
} from './containerEndpoint';
import { getEffectiveRemoteUserName, getRemoteSettings, RemoteSettings } from './settings';
import { UserIdProvider } from './user';

export interface ContainerSyncError {
    code: string;
    message: string;
}

export interface SyncedContainer {
    containerId: string;
    host: string;
    hostName?: string;
    status: string;
    endpoint?: string | null;
    startedAt?: string | null;
    expiresAt?: string | null;
    cpuUsage?: number | null;
    memoryUsage?: number | null;
    remote: boolean;
    error?: ContainerSyncError;
}

export interface ContainerSyncResult {
    containers: SyncedContainer[];
    changed: boolean;
    error?: ContainerSyncError;
}

export interface ContainerSyncOptions {
    config: ContainerConfig;
    userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    userApi?: UserRestApi;
    userApiFactory?: (baseUrl: string) => UserRestApi;
    getSettings?: () => RemoteSettings;
    now?: () => Date;
    onSync?: (result: ContainerSyncResult) => void;
    onInvalidEndpoint?: (endpoint: InvalidContainerEndpoint) => void;
}

interface RemoteStatusResult {
    response?: ContainerStatusResponse;
    parsedEndpoint?: ParsedContainerEndpoint;
    error?: ContainerSyncError;
}

const API_URL_ERROR: ContainerSyncError = {
    code: 'api_url_missing',
    message: '未配置后端 TestAgent Cloud 管理服务的 API 地址',
};

const USER_ID_ERROR: ContainerSyncError = {
    code: 'user_id_missing',
    message: '未获取到当前用户 ID',
};

const DISPOSED_ERROR: ContainerSyncError = {
    code: 'sync_disposed',
    message: '服务同步已停止',
};

export function getHostFromEndpoint(endpoint: string | null | undefined): string | undefined {
    return parseContainerEndpoint(endpoint)?.host;
}

export const DEFAULT_CONTAINER_HOST_NAME = 'TestAgent Cloud 服务';

export function getContainerHostName(
    giteeUser: string | null | undefined,
    giteeRepository: string | null | undefined,
): string {
    const user = typeof giteeUser === 'string' ? giteeUser.trim() : '';
    const repository = typeof giteeRepository === 'string' ? giteeRepository.trim() : '';
    return user && repository ? `${user}/${repository}` : DEFAULT_CONTAINER_HOST_NAME;
}

export function getUniqueHostName(baseName: string, usedNames: Set<string>): string {
    const normalizedBaseName = baseName.trim() || DEFAULT_CONTAINER_HOST_NAME;
    const normalizedUsedNames = new Set(Array.from(usedNames, normalizeHostName));
    let candidate = normalizedBaseName;
    let suffix = 1;
    while (normalizedUsedNames.has(normalizeHostName(candidate))) {
        candidate = `${normalizedBaseName} (${suffix})`;
        suffix += 1;
    }
    usedNames.add(candidate);
    normalizedUsedNames.add(normalizeHostName(candidate));
    return candidate;
}

export class ContainerSync {
    private readonly config: ContainerConfig;
    private readonly userIdProvider: Pick<UserIdProvider, 'getCurrentUserId'>;
    private readonly userApi: UserRestApi | undefined;
    private readonly userApiFactory: ((baseUrl: string) => UserRestApi) | undefined;
    private readonly getSettings: () => RemoteSettings;
    private readonly now: () => Date;
    private readonly onSync: ((result: ContainerSyncResult) => void) | undefined;
    private readonly onInvalidEndpoint: ((endpoint: InvalidContainerEndpoint) => void) | undefined;

    private inFlight: Promise<ContainerSyncResult> | undefined;
    private mutationRefresh: Promise<ContainerSyncResult> | undefined;
    private mutationGate: Promise<void> | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private readonly locallyDeletedContainerIds = new Set<string>();
    private readonly invalidEndpointNotifications = new Set<string>();

    constructor(options: ContainerSyncOptions) {
        this.config = options.config;
        this.userIdProvider = options.userIdProvider;
        this.userApi = options.userApi;
        this.userApiFactory = options.userApiFactory;
        this.getSettings = options.getSettings ?? getRemoteSettings;
        this.now = options.now ?? (() => new Date());
        this.onSync = options.onSync;
        this.onInvalidEndpoint = options.onInvalidEndpoint;
    }

    public sync(): Promise<ContainerSyncResult> {
        if (this.disposed) {
            return Promise.resolve(this.disposedResult());
        }
        if (this.mutationGate) {
            return this.mutationGate.then(() => this.sync());
        }
        if (this.inFlight) {
            return this.inFlight;
        }

        this.inFlight = this.performSync()
            .catch(error => this.resultWithError(toSyncError(error, 'sync_failed', 'TestAgent Cloud 服务同步失败')))
            .then(result => {
                if (!this.disposed) {
                    try {
                        this.onSync?.(result);
                    } catch {
                        // A sidebar listener must not turn a successful sync into an unhandled rejection.
                    }
                }
                return result;
            })
            .finally(() => {
                this.inFlight = undefined;
            });
        return this.inFlight;
    }

    public refresh(): Promise<ContainerSyncResult> {
        return this.sync();
    }

    public refreshAfterMutation(): Promise<ContainerSyncResult> {
        if (this.disposed) {
            return Promise.resolve(this.disposedResult());
        }
        if (this.mutationRefresh) {
            return this.mutationRefresh;
        }

        const waitForCurrentSync = Promise.all([
            this.mutationGate ?? Promise.resolve(),
            this.inFlight?.then(() => undefined, () => undefined) ?? Promise.resolve(),
        ]);
        const trackedRefresh = waitForCurrentSync
            .then(() => this.sync())
            .finally(() => {
                if (this.mutationRefresh === trackedRefresh) {
                    this.mutationRefresh = undefined;
                }
            });
        this.mutationRefresh = trackedRefresh;
        return trackedRefresh;
    }

    public markContainerDeleted(containerId: string): void {
        this.locallyDeletedContainerIds.add(containerId);
    }

    public clearContainerDeleted(containerId: string): void {
        this.locallyDeletedContainerIds.delete(containerId);
    }

    public runMutation<T>(operation: () => Promise<T>): Promise<T> {
        const previousGate = this.mutationGate ?? Promise.resolve();
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const operationPromise = previousGate.then(async () => {
            const currentSync = this.inFlight;
            if (currentSync) {
                await currentSync.then(() => undefined, () => undefined);
            }
            return operation();
        });
        const trackedGate = operationPromise.then(
            () => {
                release();
                return gate;
            },
            () => {
                release();
                return gate;
            },
        );
        const lifecycleReference: { promise?: Promise<void> } = {};
        const lifecycle = trackedGate.finally(() => {
            if (this.mutationGate === lifecycleReference.promise) {
                this.mutationGate = undefined;
            }
        });
        lifecycleReference.promise = lifecycle;
        this.mutationGate = lifecycle;
        return operationPromise;
    }

    public start(): void {
        if (this.disposed || this.timer) {
            return;
        }

        const settings = this.safeSettings();
        const intervalMs = getSyncIntervalMs(settings.statusSyncInterval);
        this.timer = setInterval(() => {
            void this.sync();
        }, intervalMs);
        void this.sync();
    }

    public dispose(): void {
        this.disposed = true;
        this.mutationRefresh = undefined;
        this.mutationGate = undefined;
        this.locallyDeletedContainerIds.clear();
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private async performSync(): Promise<ContainerSyncResult> {
        const settings = this.safeSettings();
        if (!settings.backendApiUrl) {
            return this.resultWithError(API_URL_ERROR);
        }

        let userId: string;
        try {
            userId = await this.userIdProvider.getCurrentUserId();
        } catch {
            return this.resultWithError(USER_ID_ERROR);
        }
        if (!userId) {
            return this.resultWithError(USER_ID_ERROR);
        }
        if (this.disposed) {
            return this.disposedResult();
        }

        let document;
        try {
            document = await this.config.read();
        } catch (error) {
            return this.resultWithError(toSyncError(error, 'config_error', '读取服务配置失败'));
        }

        const localEntries = this.config.list(document.config);
        let userApi: UserRestApi;
        try {
            userApi = this.userApiFactory
                ? this.userApiFactory(settings.backendApiUrl)
                : this.userApi ?? throwMissingUserApi();
        } catch (error) {
            return this.resultWithError(toSyncError(error, 'api_error', 'TestAgent Cloud 服务同步 API 未配置'));
        }

        let containerIdsResponse: ContainerIdsResponse;
        try {
            containerIdsResponse = await userApi.getContainerIds({ user_id: userId });
        } catch (error) {
            return {
                containers: this.localOnlyStates(localEntries, toSyncError(error, 'sync_failed', '获取服务清单失败')),
                changed: false,
                error: toSyncError(error, 'sync_failed', '获取服务清单失败'),
            };
        }
        if (this.disposed) {
            return this.disposedResult();
        }

        const remoteIds = uniqueContainerIds(containerIdsResponse.container_ids);
        for (const containerId of this.locallyDeletedContainerIds) {
            if (!remoteIds.includes(containerId)) {
                this.locallyDeletedContainerIds.delete(containerId);
            }
        }
        const visibleRemoteIds = remoteIds.filter(containerId => !this.locallyDeletedContainerIds.has(containerId));
        const remoteStatuses = await this.getRemoteStatuses(userApi, visibleRemoteIds, settings.debug);
        if (this.disposed) {
            return this.disposedResult();
        }

        const configuredUserName = settings.userName.trim();
        const userName = configuredUserName || getEffectiveRemoteUserName(settings.userName);
        let changed = configuredUserName
            ? this.config.setUserName(document.config, configuredUserName)
            : this.config.ensureUserName(document.config, userName);
        changed = this.config.setSkipKnownHostsCheck(document.config, settings.skipKnownHostsCheck) || changed;
        const localById = indexEntries(localEntries);
        const hostAssignments = this.assignHostNames(visibleRemoteIds, remoteStatuses, localEntries);

        for (const containerId of visibleRemoteIds) {
            const localEntry = localById.get(containerId);
            const assignment = hostAssignments.get(containerId);

            if (assignment?.hostName || localEntry) {
                changed = this.config.upsertContainer(document.config, {
                    containerId,
                    host: assignment?.host ?? localEntry?.host ?? DEFAULT_CONTAINER_HOST_NAME,
                    ...(assignment?.hostName ? { hostName: assignment.hostName } : {}),
                    ...(assignment?.port !== undefined ? { port: assignment.port } : {}),
                }, {
                    skipKnownHostsCheck: settings.skipKnownHostsCheck,
                    ...(!localEntry ? { userName } : {}),
                }) || changed;
            }
        }

        let expirationTimestamp: string;
        try {
            expirationTimestamp = this.now().toISOString();
        } catch (error) {
            return this.resultWithError(toSyncError(error, 'clock_error', '无法生成服务历史时间'));
        }
        for (const localEntry of localEntries) {
            if (!remoteIds.includes(localEntry.containerId) && !localEntry.expiresAt) {
                changed = this.config.setExpiresAt(document.config, localEntry.containerId, expirationTimestamp) || changed;
            }
        }

        changed = this.removeExcessHistory(document.config, settings.historyLimit) || changed;
        if (this.disposed) {
            return this.disposedResult();
        }

        if (changed) {
            try {
                await this.config.write(document);
            } catch (error) {
                return {
                    containers: [],
                    changed: false,
                    error: toSyncError(error, 'config_error', '写入服务配置失败'),
                };
            }
        }

        return {
            containers: this.buildStates(document.config, visibleRemoteIds, remoteStatuses, hostAssignments),
            changed,
        };
    }

    private async getRemoteStatuses(
        userApi: UserRestApi,
        containerIds: string[],
        allowDebugProxy: boolean,
    ): Promise<Map<string, RemoteStatusResult>> {
        const results: Array<readonly [string, RemoteStatusResult]> = await Promise.all(containerIds.map(async (containerId): Promise<readonly [string, RemoteStatusResult]> => {
            try {
                const response = await userApi.getContainer(containerId);
                const parsedEndpoint = parseContainerEndpoint(response.endpoint, { allowDebugProxy });
                if (!parsedEndpoint) {
                    this.reportInvalidEndpoint(containerId, response.endpoint);
                    return [containerId, {
                        response,
                        error: { code: 'invalid_endpoint', message: 'TestAgent Cloud 服务 endpoint 必须是 IP:Port' },
                    }] as const;
                }
                this.clearInvalidEndpointNotifications(containerId);
                return [containerId, { response, parsedEndpoint }] as const;
            } catch (error) {
                return [containerId, { error: toSyncError(error, 'status_failed', '获取服务状态失败') }] as const;
            }
        }));
        return new Map(results);
    }

    private removeExcessHistory(config: import('ssh-config').default, historyLimit: number): boolean {
        if (historyLimit === 0) {
            return false;
        }

        const normalizedLimit = Number.isInteger(historyLimit) && historyLimit >= 0 ? historyLimit : 5;
        const history = this.config.list(config)
            .filter(entry => entry.expiresAt)
            .sort((left, right) => compareExpiration(left, right));
        if (normalizedLimit === 0 || history.length <= normalizedLimit) {
            return false;
        }

        let changed = false;
        for (const entry of history.slice(0, history.length - normalizedLimit)) {
            changed = this.config.removeContainer(config, entry.containerId) || changed;
        }
        return changed;
    }

    private buildStates(
        config: import('ssh-config').default,
        remoteIds: string[],
        remoteStatuses: Map<string, RemoteStatusResult>,
        hostAssignments: Map<string, HostAssignment>,
    ): SyncedContainer[] {
        const entries = indexEntries(this.config.list(config));
        const states: SyncedContainer[] = remoteIds.map(containerId => {
            const entry = entries.get(containerId);
            const remoteStatus = remoteStatuses.get(containerId);
            const response = remoteStatus?.response;
            const assignment = hostAssignments.get(containerId);
            const host = entry?.host ?? assignment?.host ?? '';
            const hostName = entry?.hostName ?? assignment?.hostName ?? remoteStatus?.parsedEndpoint?.host;
            const port = entry?.port ?? assignment?.port ?? remoteStatus?.parsedEndpoint?.port;
            const endpointError = !entry && response && !hostName
                ? { code: 'endpoint_missing', message: 'TestAgent Cloud 服务状态未返回可用 endpoint' }
                : undefined;
            return {
                containerId,
                host,
                ...(hostName ? { hostName } : {}),
                ...(port !== undefined ? { port } : {}),
                status: response?.status ?? 'unknown',
                endpoint: response?.endpoint,
                startedAt: response?.started_at,
                expiresAt: response?.expires_at,
                ...(response?.cpu_usage !== undefined ? { cpuUsage: response.cpu_usage } : {}),
                ...(response?.memory_usage !== undefined ? { memoryUsage: response.memory_usage } : {}),
                remote: true,
                ...(remoteStatus?.error || endpointError ? { error: remoteStatus?.error ?? endpointError } : {}),
            };
        });
        const remoteIdSet = new Set(remoteIds);
        for (const entry of entries.values()) {
            if (!remoteIdSet.has(entry.containerId)) {
                states.push({
                    containerId: entry.containerId,
                    host: entry.host,
                    status: 'missing',
                    expiresAt: entry.expiresAt,
                    remote: false,
                });
            }
        }
        return states;
    }

    private localOnlyStates(entries: ContainerConfigEntry[], error: ContainerSyncError): SyncedContainer[] {
        return Array.from(indexEntries(entries).values(), entry => ({
            containerId: entry.containerId,
            host: entry.host,
            ...(entry.hostName ? { hostName: entry.hostName } : {}),
            ...(entry.port !== undefined ? { port: entry.port } : {}),
            status: entry.expiresAt ? 'missing' : 'unknown',
            expiresAt: entry.expiresAt,
            remote: false,
            error,
        }));
    }

    private resultWithError(error: ContainerSyncError): ContainerSyncResult {
        return { containers: [], changed: false, error };
    }

    private disposedResult(): ContainerSyncResult {
        return this.resultWithError(DISPOSED_ERROR);
    }

    private assignHostNames(
        remoteIds: string[],
        remoteStatuses: Map<string, RemoteStatusResult>,
        localEntries: ContainerConfigEntry[],
    ): Map<string, HostAssignment> {
        const remoteIdSet = new Set(remoteIds);
        const usedNames = new Set<string>();
        for (const entry of localEntries) {
            if (!remoteIdSet.has(entry.containerId) && entry.host.trim()) {
                usedNames.add(entry.host);
            }
        }

        const assignments = new Map<string, HostAssignment>();
        const localById = indexEntries(localEntries);
        for (const containerId of remoteIds) {
            const localEntry = localById.get(containerId);
            const remoteStatus = remoteStatuses.get(containerId);
            const response = remoteStatus?.response;
            const hostName = remoteStatus?.parsedEndpoint?.host ?? localEntry?.hostName ?? localEntry?.host;
            const port = remoteStatus?.parsedEndpoint?.port ?? localEntry?.port;
            const baseName = response
                ? getContainerHostName(response.gitee_user, response.gitee_repository)
                : localEntry?.host ?? DEFAULT_CONTAINER_HOST_NAME;
            assignments.set(containerId, {
                host: getUniqueHostName(baseName, usedNames),
                ...(hostName ? { hostName } : {}),
                ...(port !== undefined ? { port } : {}),
            });
        }
        return assignments;
    }

    private reportInvalidEndpoint(containerId: string, endpoint: string | null | undefined): void {
        const key = `${containerId}\u0000${String(endpoint)}`;
        if (this.invalidEndpointNotifications.has(key)) {
            return;
        }
        this.invalidEndpointNotifications.add(key);
        try {
            this.onInvalidEndpoint?.({ containerId, endpoint });
        } catch {
            // An error notification must not abort synchronization.
        }
    }

    private clearInvalidEndpointNotifications(containerId: string): void {
        const prefix = `${containerId}\u0000`;
        for (const key of this.invalidEndpointNotifications) {
            if (key.startsWith(prefix)) {
                this.invalidEndpointNotifications.delete(key);
            }
        }
    }

    private safeSettings(): RemoteSettings {
        try {
            return this.getSettings();
        } catch {
            return getRemoteSettings();
        }
    }
}

interface HostAssignment {
    host: string;
    hostName?: string;
    port?: number;
}

function indexEntries(entries: ContainerConfigEntry[]): Map<string, ContainerConfigEntry> {
    const result = new Map<string, ContainerConfigEntry>();
    for (const entry of entries) {
        if (!result.has(entry.containerId)) {
            result.set(entry.containerId, entry);
        }
    }
    return result;
}

function uniqueContainerIds(containerIds: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const containerId of containerIds) {
        if (typeof containerId !== 'string' || !containerId.trim() || seen.has(containerId)) {
            continue;
        }
        seen.add(containerId);
        result.push(containerId);
    }
    return result;
}

function compareExpiration(left: ContainerConfigEntry, right: ContainerConfigEntry): number {
    const leftTime = Date.parse(left.expiresAt ?? '');
    const rightTime = Date.parse(right.expiresAt ?? '');
    const normalizedLeft = Number.isNaN(leftTime) ? Number.NEGATIVE_INFINITY : leftTime;
    const normalizedRight = Number.isNaN(rightTime) ? Number.NEGATIVE_INFINITY : rightTime;
    return normalizedLeft - normalizedRight;
}

function normalizeHostName(hostName: string): string {
    return hostName.trim().toLocaleLowerCase();
}

function getSyncIntervalMs(seconds: number): number {
    return Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000);
}

function toSyncError(error: unknown, fallbackCode: string, fallbackMessage: string): ContainerSyncError {
    if (error instanceof RestClientError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error && error.message) {
        return { code: fallbackCode, message: error.message };
    }
    return { code: fallbackCode, message: fallbackMessage };
}

function throwMissingUserApi(): never {
    throw new Error('User REST API is not configured');
}
