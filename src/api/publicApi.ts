import * as vscode from 'vscode';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ContainerConfig, type ContainerConfigEntry } from '../containerConfig';
import { getContainerHostName, getUniqueHostName } from '../containerSync';
import { ContainerInitializationRunner, combineAbortSignals, getInitializationResultContainer } from '../containerInitializationPoller';
import { Log } from '../common/logger';
import { getRemoteSettings, RemoteSettings } from '../settings';
import { UserIdProvider } from '../user';
import { parseContainerEndpoint } from '../containerEndpoint';
import {
    ContainerStatusResponse,
    CreateContainerResponse,
    ServiceIdsResponse,
    AdminCheckResponse,
    FileSyncResult,
    PublicContainerCallback,
    PublicCreateContainerCallbacks,
    PublicFileSyncConflict,
    UserContainerQuery,
    UserCreateContainerRequest,
} from './models';
import { FileSyncError, FileSyncRunner, FileSyncService, getRemoteServiceId, SftpProvider } from './fileSync';
import {
    RestClient,
    RestClientError,
    RestClientErrorKind,
    UserRestApi,
} from './restClient';

export const PUBLIC_EXTENSION_ID = 'test-tech.tscode-remote-ssh';

export const PUBLIC_API_ERROR_CODES = {
    INVALID_ARGUMENT: 'invalid_argument',
    USER_ID_MISSING: 'user_id_missing',
    CALLBACK_FAILED: 'callback_failed',
    SYNC_STAGE_INVALID: 'sync_stage_invalid',
} as const;

export type PublicCreateContainerRequest = Omit<UserCreateContainerRequest, 'user_id'> & {
    plugin_id: string;
    callbacks?: PublicCreateContainerCallbacks;
};

export type PublicContainerQuery = Omit<UserContainerQuery, 'user_id'>;

export type PublicContainerStatusResponse = ContainerStatusResponse & {
    name?: string;
};

export interface PublicUserContainerApi {
    createContainer(
        request: PublicCreateContainerRequest,
        options?: { initializationSignal?: AbortSignal },
    ): Promise<CreateContainerResponse>;
    getActiveServiceIds(query?: PublicContainerQuery): Promise<ServiceIdsResponse>;
    getContainer(serviceId: string): Promise<PublicContainerStatusResponse>;
    checkAdmin(): Promise<AdminCheckResponse>;
    /** During create callbacks, this is allowed only in containerPrepared. */
    syncFiles(
        source: string,
        target: string,
        conflict?: PublicFileSyncConflict,
        mirror?: boolean,
        container?: ContainerConfigEntry,
    ): Promise<FileSyncResult>;
    startContainer(serviceId: string): Promise<void>;
    stopContainer(serviceId: string): Promise<void>;
    restartContainer(serviceId: string): Promise<void>;
    deleteContainer(serviceId: string): Promise<void>;
}

export type TestAgentRemoteApi = PublicUserContainerApi;

export class PublicApiError extends RestClientError {
    public constructor(
        kind: RestClientErrorKind,
        code: string,
        message: string,
        cause?: unknown,
    ) {
        super(kind, code, message, undefined, cause);
        this.name = 'PublicApiError';
    }
}

export class PublicApiCallbackError extends Error {
    public readonly code = PUBLIC_API_ERROR_CODES.CALLBACK_FAILED;
    public readonly cause: unknown;

    public constructor(
        public readonly pluginId: string,
        public readonly pluginName: string,
        public readonly stage: keyof PublicCreateContainerCallbacks,
        public readonly serviceId: string,
        public readonly originalError: unknown,
        public readonly cleanupError?: unknown,
    ) {
        const cleanupMessage = cleanupError === undefined
            ? `服务 "${serviceId}" 已提交业务删除请求`
            : `服务 "${serviceId}" 的业务删除失败：${formatErrorDetails(cleanupError)}`;
        super(
            `插件 "${pluginName}" (${pluginId}) 的 ${stage} 回调失败，服务 "${serviceId}"。`
            + `回调错误：${formatErrorDetails(originalError)}。${cleanupMessage}`,
        );
        this.name = 'PublicApiCallbackError';
        this.cause = originalError;
    }
}

interface CallbackExecutionScope {
    stage: keyof PublicCreateContainerCallbacks;
    serviceId: string;
    container: ContainerConfigEntry;
    active: boolean;
}

const callbackExecution = new AsyncLocalStorage<CallbackExecutionScope>();

export interface PublicUserContainerApiOptions {
    userIdProvider?: Pick<UserIdProvider, 'getCurrentUserId'>;
    getSettings?: () => RemoteSettings;
    userApiFactory?: (baseUrl: string) => UserRestApi;
    initializationPoller?: ContainerInitializationRunner;
    initializationSignal?: AbortSignal;
    containerConfig?: Pick<ContainerConfig, 'read' | 'list'>;
    fileSync?: FileSyncRunner;
    sftpProvider?: SftpProvider;
    logger?: Pick<Log, 'error'>;
}

export function createPublicUserContainerApi(
    options: PublicUserContainerApiOptions = {},
): PublicUserContainerApi {
    const userIdProvider = options.userIdProvider ?? new UserIdProvider();
    const getSettings = options.getSettings ?? getRemoteSettings;
    const userApiFactory = options.userApiFactory ?? ((baseUrl: string) => new RestClient(baseUrl).user);
    const initializationPoller = options.initializationPoller;

    const getUserApi = (): UserRestApi => userApiFactory(getSettings().backendApiUrl);

    const prepareUserRequest = async (): Promise<{ userId: string; userApi: UserRestApi }> => {
        let currentUserId: unknown;
        try {
            currentUserId = await userIdProvider.getCurrentUserId();
        } catch (error) {
            throw new PublicApiError(
                'configuration',
                PUBLIC_API_ERROR_CODES.USER_ID_MISSING,
                '未获取到当前用户 ID',
                error,
            );
        }

        if (typeof currentUserId !== 'string' || !currentUserId.trim()) {
            throw new PublicApiError(
                'configuration',
                PUBLIC_API_ERROR_CODES.USER_ID_MISSING,
                '未获取到当前用户 ID',
            );
        }

        return { userId: currentUserId.trim(), userApi: getUserApi() };
    };

    const assertObject: (value: unknown, message: string) => asserts value is Record<string, unknown> = (value, message) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new PublicApiError('request', PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT, message);
        }
    };

    const fileSync = options.fileSync ?? new FileSyncService({
        config: options.containerConfig ?? new ContainerConfig(),
        getContainerStatus: async serviceId => {
            const { userApi } = await prepareUserRequest();
            return userApi.getContainer(serviceId);
        },
        sftpProvider: options.sftpProvider,
        allowDebugProxy: getSettings().debug,
    });

    return {
        createContainer: async (request, createOptions) => {
            assertObject(request, '请求必须是对象');
            const pluginId = normalizePluginId(request.plugin_id);
            const callbacks = normalizeCallbacks(request.callbacks);
            const { userId, userApi } = await prepareUserRequest();
            const requestFields = omitPublicFields(request, new Set(['plugin_id', 'callbacks', 'user_id']));
            const created = stripPublicCreateFields(await userApi.createContainer({
                ...requestFields,
                user_id: userId,
            }));

            let callbackContainer: ContainerConfigEntry | undefined;
            const invokeCallback = async (
                stage: keyof PublicCreateContainerCallbacks,
                callback: PublicContainerCallback | undefined,
                container: Pick<ContainerStatusResponse, 'endpoint' | 'expires_at' | 'gitee_user' | 'gitee_repository'>,
            ): Promise<void> => {
                if (!callback) {
                    return;
                }
                callbackContainer = await getCreateContainerEntry(
                    options.containerConfig,
                    created.service_id,
                    container.endpoint,
                    container.gitee_user,
                    container.gitee_repository,
                    container.expires_at,
                    callbackContainer,
                    getSettings().debug,
                );
                await runCreateCallback(stage, callback, {
                    pluginId,
                    userApi,
                    serviceId: created.service_id,
                    container: callbackContainer,
                });
            };

            await invokeCallback('postCompleted', callbacks.postCompleted, {
                endpoint: created.endpoint,
                expires_at: created.expires_at,
                gitee_user: typeof requestFields['gitee_user'] === 'string' ? requestFields['gitee_user'] : '',
                gitee_repository: typeof requestFields['gitee_repository'] === 'string' ? requestFields['gitee_repository'] : '',
            });

            let result: CreateContainerResponse = created;
            let finalContainer: ContainerStatusResponse | undefined;
            if (initializationPoller) {
                // The postCompleted callback is the handoff into the internal waiting/SSH/Git initialization flow.
                const initialization = await initializationPoller.initialize({
                    serviceId: created.service_id,
                    operatorUserId: userId,
                    endpoint: created.endpoint,
                    statusReader: userApi,
                    signal: combineAbortSignals(options.initializationSignal, createOptions?.initializationSignal),
                });
                const initializedContainer = getInitializationResultContainer(initialization);
                finalContainer = initializedContainer ? stripUserId(initializedContainer) : undefined;
                if (finalContainer) {
                    await invokeCallback('gitInitialized', callbacks.gitInitialized, finalContainer);
                    result = mergeFinalContainerStatus(created, finalContainer);
                }
            }

            if (finalContainer?.status?.trim().toLowerCase() === 'running'
                || (!initializationPoller && created.status?.trim().toLowerCase() === 'running')) {
                await invokeCallback('containerPrepared', callbacks.containerPrepared, finalContainer ?? {
                    endpoint: created.endpoint,
                    expires_at: created.expires_at,
                    gitee_user: typeof requestFields['gitee_user'] === 'string' ? requestFields['gitee_user'] : '',
                    gitee_repository: typeof requestFields['gitee_repository'] === 'string' ? requestFields['gitee_repository'] : '',
                });
            }
            return result;
        },
        getActiveServiceIds: async query => {
            const normalizedQuery = query ?? {};
            assertObject(normalizedQuery, '查询参数必须是对象');
            const { userId, userApi } = await prepareUserRequest();
            const queryFields = omitPublicFields(normalizedQuery, new Set(['user_id']));
            const response = await userApi.getContainerStatuses({ ...queryFields, user_id: userId });
            const serviceIds: string[] = [];
            const seen = new Set<string>();
            for (const container of response.containers ?? []) {
                if (typeof container.service_id !== 'string'
                    || typeof container.status !== 'string'
                    || container.status.trim().toLowerCase() !== 'running'
                    || seen.has(container.service_id)) {
                    continue;
                }
                seen.add(container.service_id);
                serviceIds.push(container.service_id);
            }
            return { service_ids: serviceIds };
        },
        getContainer: async serviceId => {
            const { userApi } = await prepareUserRequest();
            const response = stripPublicContainerFields(await userApi.getContainer(serviceId));
            const name = await getConfiguredContainerName(options.containerConfig, serviceId);
            return name === undefined ? response : { ...response, name };
        },
        checkAdmin: async () => {
            const { userId, userApi } = await prepareUserRequest();
            return stripUserId(await userApi.checkAdmin({ user_id: userId }));
        },
        syncFiles: (source, target, conflict, mirror, container) => {
            const scope = callbackExecution.getStore();
            if (scope && (!scope.active || scope.stage !== 'containerPrepared')) {
                return Promise.reject(new FileSyncError(
                    'sync_stage_invalid',
                    '创建流程中的文件同步仅允许在 containerPrepared 回调中调用',
                ));
            }

            let effectiveContainer = container;
            if (scope) {
                let serviceId: string;
                try {
                    serviceId = getRemoteServiceId(source, target);
                } catch (error) {
                    return Promise.reject(error);
                }
                if (serviceId !== scope.serviceId
                    || (container && (container.serviceId !== scope.serviceId || container.host !== scope.container.host))) {
                    return Promise.reject(new FileSyncError(
                        'container_info_mismatch',
                        `containerPrepared 回调只能使用服务 "${scope.serviceId}" 的 SSH 配置项同步`,
                    ));
                }
                effectiveContainer ??= scope.container;
            }

            return fileSync.syncFiles(source, target, conflict, mirror, effectiveContainer);
        },
        startContainer: async serviceId => {
            const { userApi } = await prepareUserRequest();
            await userApi.startContainer(serviceId);
        },
        stopContainer: async serviceId => {
            const { userApi } = await prepareUserRequest();
            await userApi.stopContainer(serviceId);
        },
        restartContainer: async serviceId => {
            const { userApi } = await prepareUserRequest();
            await userApi.restartContainer(serviceId);
        },
        deleteContainer: async serviceId => {
            const { userApi } = await prepareUserRequest();
            await userApi.deleteContainer(serviceId);
        },
    };

    async function runCreateCallback(
        stage: keyof PublicCreateContainerCallbacks,
        callback: PublicContainerCallback | undefined,
        context: { pluginId: string; userApi: UserRestApi; serviceId: string; container: ContainerConfigEntry },
    ): Promise<void> {
        if (!callback) {
            return;
        }
        const scope: CallbackExecutionScope = {
            stage,
            serviceId: context.serviceId,
            container: { ...context.container },
            active: true,
        };
        const callbackContainer = { ...context.container };
        try {
            await callbackExecution.run(scope, () => callback(callbackContainer));
        } catch (error) {
            scope.active = false;
            let cleanupError: unknown;
            try {
                await context.userApi.deleteContainer(context.serviceId);
            } catch (error) {
                cleanupError = error;
            }
            const callbackError = new PublicApiCallbackError(
                context.pluginId,
                getPluginDisplayName(context.pluginId),
                stage,
                context.serviceId,
                error,
                cleanupError,
            );
            const logData = {
                pluginId: callbackError.pluginId,
                pluginName: callbackError.pluginName,
                stage: callbackError.stage,
                serviceId: callbackError.serviceId,
                originalError: callbackError.originalError,
                cleanupError: callbackError.cleanupError,
            };
            if (options.logger) {
                options.logger.error(callbackError.message, logData);
            } else {
                console.error(callbackError.message, logData);
            }
            try {
                await vscode.window.showErrorMessage(callbackError.message, { modal: true });
            } catch {
                // A UI notification must not hide the callback failure.
            }
            throw callbackError;
        } finally {
            scope.active = false;
        }
    }
}

function normalizePluginId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new PublicApiError('request', PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT, 'plugin_id 不能为空');
    }
    return value.trim();
}

function normalizeCallbacks(value: unknown): PublicCreateContainerCallbacks {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new PublicApiError('request', PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT, 'callbacks 必须是对象');
    }
    const callbacks = value as Record<string, unknown>;
    const result: PublicCreateContainerCallbacks = {};
    for (const stage of ['postCompleted', 'gitInitialized', 'containerPrepared'] as const) {
        if (callbacks[stage] !== undefined && typeof callbacks[stage] !== 'function') {
            throw new PublicApiError('request', PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT, `${stage} 必须是函数`);
        }
        if (typeof callbacks[stage] === 'function') {
            result[stage] = callbacks[stage] as PublicCreateContainerCallbacks[typeof stage];
        }
    }
    return result;
}

function getPluginDisplayName(pluginId: string): string {
    try {
        const extension = vscode.extensions?.getExtension(pluginId);
        const packageJson = extension?.packageJSON as { displayName?: unknown; name?: unknown } | undefined;
        if (typeof packageJson?.displayName === 'string' && packageJson.displayName.trim()) {
            return packageJson.displayName.trim();
        }
        if (typeof packageJson?.name === 'string' && packageJson.name.trim()) {
            return packageJson.name.trim();
        }
    } catch {
        // Use the stable extension ID when the caller is not visible in this host.
    }
    return pluginId;
}

async function getConfiguredContainerName(
    config: Pick<ContainerConfig, 'read' | 'list'> | undefined,
    serviceId: string,
): Promise<string | undefined> {
    if (!config) {
        return undefined;
    }
    const document = await config.read();
    const entry = config.list(document.config).find(item => item.serviceId === serviceId);
    if (!entry) {
        return undefined;
    }
    return entry.name?.trim() || entry.host.trim() || undefined;
}

async function getCreateContainerEntry(
    config: Pick<ContainerConfig, 'read' | 'list'> | undefined,
    serviceId: string,
    endpoint: string | null | undefined,
    giteeUser: string | null | undefined,
    giteeRepository: string | null | undefined,
    expiresAt: string | null | undefined,
    previous: ContainerConfigEntry | undefined,
    allowDebugProxy: boolean,
): Promise<ContainerConfigEntry> {
    let entries: ContainerConfigEntry[] = [];
    if (config) {
        try {
            const document = await config.read();
            entries = config.list(document.config);
        } catch {
            // The callback gets a transient entry even when the local config is unavailable.
        }
    }

    const existing = entries.find(entry => entry.serviceId === serviceId);
    const usedHosts = new Set(entries
        .filter(entry => entry.serviceId !== serviceId)
        .map(entry => entry.host.trim())
        .filter(Boolean));
    const baseName = getContainerHostName(giteeUser, giteeRepository);
    const host = previous?.host
        || existing?.host
        || getUniqueHostName(baseName, usedHosts);
    const parsedEndpoint = parseContainerEndpoint(endpoint, { allowDebugProxy });
    const entry: ContainerConfigEntry = {
        serviceId,
        host,
        name: existing?.name?.trim() || previous?.name?.trim() || host,
    };
    const hostName = parsedEndpoint?.host || previous?.hostName || existing?.hostName;
    const port = parsedEndpoint?.port || previous?.port || existing?.port;
    const resolvedExpiration = expiresAt?.trim() || previous?.expiresAt || existing?.expiresAt;
    if (hostName) {
        entry.hostName = hostName;
    }
    if (port) {
        entry.port = port;
    }
    if (resolvedExpiration) {
        entry.expiresAt = resolvedExpiration;
    }
    return entry;
}

function formatErrorDetails(error: unknown): string {
    const details: string[] = [];
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
        if (typeof current === 'object' && current !== null) {
            if (seen.has(current)) {
                break;
            }
            seen.add(current);
            const value = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
            const message = typeof value.message === 'string' ? value.message : String(current);
            const code = typeof value.code === 'string' && value.code ? `[${value.code}] ` : '';
            const name = typeof value.name === 'string' && value.name !== 'Error' ? `${value.name}: ` : '';
            details.push(`${code}${name}${message}`);
            current = value.cause;
            continue;
        }
        details.push(String(current));
        break;
    }
    const formatted = details.join(' <- ') || '未知错误';
    return formatted.length > 800 ? `${formatted.slice(0, 797)}...` : formatted;
}

function mergeFinalContainerStatus(created: CreateContainerResponse, finalContainer: ContainerStatusResponse): CreateContainerResponse {
    const result: CreateContainerResponse = {
        ...created,
        status: finalContainer.status,
    };
    if (Object.prototype.hasOwnProperty.call(finalContainer, 'type')) {
        result.type = finalContainer.type;
    }
    if (Object.prototype.hasOwnProperty.call(finalContainer, 'novnc_url')) {
        result.novnc_url = finalContainer.novnc_url;
    }
    if (Object.prototype.hasOwnProperty.call(finalContainer, 'endpoint')) {
        result.endpoint = finalContainer.endpoint;
    }
    if (Object.prototype.hasOwnProperty.call(finalContainer, 'started_at')) {
        result.started_at = finalContainer.started_at;
    }
    if (Object.prototype.hasOwnProperty.call(finalContainer, 'expires_at')) {
        result.expires_at = finalContainer.expires_at;
    }
    return result;
}

function stripUserId<T extends object>(value: T): T {
    const safeValue = { ...value } as T & { user_id?: unknown };
    delete safeValue.user_id;
    return safeValue as T;
}

function stripPublicContainerFields<T extends object>(value: T): T {
    const safeValue = stripUserId(value) as T & { container_id?: unknown; name?: unknown };
    delete safeValue.container_id;
    delete safeValue.name;
    return safeValue as T;
}

function stripPublicCreateFields<T extends object>(value: T): T {
    const safeValue = stripUserId(value) as T & { container_id?: unknown; plugin_id?: unknown; callbacks?: unknown };
    delete safeValue.container_id;
    delete safeValue.plugin_id;
    delete safeValue.callbacks;
    return safeValue as T;
}

function omitPublicFields(value: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key)));
}
