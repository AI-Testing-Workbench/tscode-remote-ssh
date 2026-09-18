import * as vscode from 'vscode';
import { ContainerConfig } from '../containerConfig';
import { ContainerInitializationRunner, combineAbortSignals, getInitializationResultContainer } from '../containerInitializationPoller';
import { Log } from '../common/logger';
import { getRemoteSettings, RemoteSettings } from '../settings';
import { UserIdProvider } from '../user';
import {
    ContainerIdsResponse,
    ContainerStatusResponse,
    CreateContainerResponse,
    AdminCheckResponse,
    FileSyncResult,
    PublicCreateContainerCallbacks,
    PublicFileSyncConflict,
    UserContainerQuery,
    UserCreateContainerRequest,
} from './models';
import { FileSyncRunner, FileSyncService, SftpProvider } from './fileSync';
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
    getActiveContainerIds(query?: PublicContainerQuery): Promise<ContainerIdsResponse>;
    getContainer(containerId: string): Promise<PublicContainerStatusResponse>;
    checkAdmin(): Promise<AdminCheckResponse>;
    syncFiles(
        source: string,
        target: string,
        conflict?: PublicFileSyncConflict,
        mirror?: boolean,
    ): Promise<FileSyncResult>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
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
        public readonly originalError: unknown,
        public readonly cleanupError?: unknown,
    ) {
        const cleanupMessage = cleanupError === undefined
            ? '创建的容器已提交业务删除'
            : '业务删除也失败，请检查后端服务状态';
        super(`插件 "${pluginName}" (${pluginId}) 的 ${stage} 回调失败，${cleanupMessage}`);
        this.name = 'PublicApiCallbackError';
        this.cause = originalError;
    }
}

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
        getContainerStatus: async containerId => {
            const { userApi } = await prepareUserRequest();
            return userApi.getContainer(containerId);
        },
        sftpProvider: options.sftpProvider,
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

            await runCreateCallback('postCompleted', callbacks.postCompleted, {
                pluginId,
                userApi,
                containerId: created.container_id,
            });

            let result: CreateContainerResponse = created;
            let finalContainer: ContainerStatusResponse | undefined;
            if (initializationPoller) {
                const initialization = await initializationPoller.initialize({
                    containerId: created.container_id,
                    serviceId: created.service_id,
                    operatorUserId: userId,
                    endpoint: created.endpoint,
                    statusReader: userApi,
                    signal: combineAbortSignals(options.initializationSignal, createOptions?.initializationSignal),
                });
                const initializedContainer = getInitializationResultContainer(initialization);
                finalContainer = initializedContainer ? stripUserId(initializedContainer) : undefined;
                if (finalContainer) {
                    await runCreateCallback('gitInitialized', callbacks.gitInitialized, {
                        pluginId,
                        userApi,
                        containerId: created.container_id,
                    });
                    result = mergeFinalContainerStatus(created, finalContainer);
                }
            }

            if (finalContainer?.status?.trim().toLowerCase() === 'running'
                || (!initializationPoller && created.status?.trim().toLowerCase() === 'running')) {
                await runCreateCallback('containerPrepared', callbacks.containerPrepared, {
                    pluginId,
                    userApi,
                    containerId: created.container_id,
                });
            }
            return result;
        },
        getActiveContainerIds: async query => {
            const normalizedQuery = query ?? {};
            assertObject(normalizedQuery, '查询参数必须是对象');
            const { userId, userApi } = await prepareUserRequest();
            const queryFields = omitPublicFields(normalizedQuery, new Set(['user_id']));
            const response = await userApi.getContainerStatuses({ ...queryFields, user_id: userId });
            const containerIds: string[] = [];
            const seen = new Set<string>();
            for (const container of response.containers ?? []) {
                if (typeof container.container_id !== 'string'
                    || typeof container.status !== 'string'
                    || container.status.trim().toLowerCase() !== 'running'
                    || seen.has(container.container_id)) {
                    continue;
                }
                seen.add(container.container_id);
                containerIds.push(container.container_id);
            }
            return { container_ids: containerIds };
        },
        getContainer: async containerId => {
            const { userApi } = await prepareUserRequest();
            const response = stripPublicContainerFields(await userApi.getContainer(containerId));
            const name = await getConfiguredContainerName(options.containerConfig, containerId);
            return name === undefined ? response : { ...response, name };
        },
        checkAdmin: async () => {
            const { userId, userApi } = await prepareUserRequest();
            return stripUserId(await userApi.checkAdmin({ user_id: userId }));
        },
        syncFiles: (source, target, conflict, mirror) => fileSync.syncFiles(source, target, conflict, mirror),
        startContainer: async containerId => {
            const { userApi } = await prepareUserRequest();
            await userApi.startContainer(containerId);
        },
        stopContainer: async containerId => {
            const { userApi } = await prepareUserRequest();
            await userApi.stopContainer(containerId);
        },
        restartContainer: async containerId => {
            const { userApi } = await prepareUserRequest();
            await userApi.restartContainer(containerId);
        },
        deleteContainer: async containerId => {
            const { userApi } = await prepareUserRequest();
            await userApi.deleteContainer(containerId);
        },
    };

    async function runCreateCallback(
        stage: keyof PublicCreateContainerCallbacks,
        callback: (() => void | Promise<void>) | undefined,
        context: { pluginId: string; userApi: UserRestApi; containerId: string },
    ): Promise<void> {
        if (!callback) {
            return;
        }
        try {
            await callback();
        } catch (originalError) {
            let cleanupError: unknown;
            try {
                await context.userApi.deleteContainer(context.containerId);
            } catch (error) {
                cleanupError = error;
            }
            const callbackError = new PublicApiCallbackError(
                context.pluginId,
                getPluginDisplayName(context.pluginId),
                stage,
                originalError,
                cleanupError,
            );
            const logData = {
                pluginId: callbackError.pluginId,
                pluginName: callbackError.pluginName,
                stage: callbackError.stage,
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
    containerId: string,
): Promise<string | undefined> {
    if (!config) {
        return undefined;
    }
    const document = await config.read();
    const entry = config.list(document.config).find(item => item.containerId === containerId);
    if (!entry) {
        return undefined;
    }
    return entry.name?.trim() || entry.host.trim() || undefined;
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
    const safeValue = stripUserId(value) as T & { name?: unknown };
    delete safeValue.name;
    return safeValue as T;
}

function stripPublicCreateFields<T extends object>(value: T): T {
    const safeValue = stripUserId(value) as T & { plugin_id?: unknown; callbacks?: unknown };
    delete safeValue.plugin_id;
    delete safeValue.callbacks;
    return safeValue as T;
}

function omitPublicFields(value: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.has(key)));
}
