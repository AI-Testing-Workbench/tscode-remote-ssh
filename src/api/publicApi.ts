import { getRemoteSettings, RemoteSettings } from '../settings';
import { UserIdProvider } from '../user';
import {
    ContainerIdsResponse,
    ContainerStatusResponse,
    CreateContainerRequest,
    CreateContainerResponse,
    UserContainerQuery,
} from './models';
import {
    RestClient,
    RestClientError,
    RestClientErrorKind,
    UserRestApi,
} from './restClient';

export const PUBLIC_API_ERROR_CODES = {
    INVALID_ARGUMENT: 'invalid_argument',
    USER_ID_MISSING: 'user_id_missing',
    USER_ID_MISMATCH: 'user_id_mismatch',
} as const;

export type PublicCreateContainerRequest = Omit<CreateContainerRequest, 'user_id'> & {
    user_id?: string | null;
};

export type PublicContainerQuery = Omit<UserContainerQuery, 'user_id'> & {
    user_id?: string | null;
};

export interface PublicUserContainerApi {
    createContainer(request: PublicCreateContainerRequest): Promise<CreateContainerResponse>;
    getContainerIds(query?: PublicContainerQuery): Promise<ContainerIdsResponse>;
    getContainer(containerId: string): Promise<ContainerStatusResponse>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
}

export type TestAgentRemoteApi = PublicUserContainerApi;

export class PublicApiError extends RestClientError {
    constructor(
        kind: RestClientErrorKind,
        code: string,
        message: string,
        cause?: unknown,
    ) {
        super(kind, code, message, undefined, cause);
        this.name = 'PublicApiError';
    }
}

export interface PublicUserContainerApiOptions {
    userIdProvider?: Pick<UserIdProvider, 'getCurrentUserId'>;
    getSettings?: () => RemoteSettings;
    userApiFactory?: (baseUrl: string) => UserRestApi;
}

export function createPublicUserContainerApi(
    options: PublicUserContainerApiOptions = {},
): PublicUserContainerApi {
    const userIdProvider = options.userIdProvider ?? new UserIdProvider();
    const getSettings = options.getSettings ?? getRemoteSettings;
    const userApiFactory = options.userApiFactory ?? ((baseUrl: string) => new RestClient(baseUrl).user);

    const getUserApi = (): UserRestApi => userApiFactory(getSettings().backendApiUrl);

    const prepareUserRequest = async (requestedUserId: unknown): Promise<{ userId: string; userApi: UserRestApi }> => {
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

        const normalizedUserId = currentUserId.trim();
        if (requestedUserId !== undefined) {
            if (typeof requestedUserId !== 'string' || !requestedUserId.trim()) {
                throw new PublicApiError(
                    'request',
                    PUBLIC_API_ERROR_CODES.USER_ID_MISMATCH,
                    'TestAgent Cloud 服务创建 API 的 user_id 不能为空',
                );
            }
        }

        return { userId: normalizedUserId, userApi: getUserApi() };
    };

    const assertObject: (value: unknown, message: string) => asserts value is Record<string, unknown> = (value, message) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new PublicApiError('request', PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT, message);
        }
    };

    return {
        createContainer: async request => {
            assertObject(request, '创建 TestAgent Cloud 服务请求必须是对象');
            const { userId, userApi } = await prepareUserRequest(request.user_id);
            return userApi.createContainer({ ...request, user_id: userId });
        },
        getContainerIds: async query => {
            const normalizedQuery = query ?? {};
            assertObject(normalizedQuery, 'TestAgent Cloud 服务查询参数必须是对象');
            const { userId, userApi } = await prepareUserRequest(normalizedQuery.user_id);
            return userApi.getContainerIds({ ...normalizedQuery, user_id: userId });
        },
        getContainer: async containerId => {
            const { userApi } = await prepareUserRequest(undefined);
            return userApi.getContainer(containerId);
        },
        startContainer: async containerId => {
            const { userApi } = await prepareUserRequest(undefined);
            await userApi.startContainer(containerId);
        },
        stopContainer: async containerId => {
            const { userApi } = await prepareUserRequest(undefined);
            await userApi.stopContainer(containerId);
        },
        restartContainer: async containerId => {
            const { userApi } = await prepareUserRequest(undefined);
            await userApi.restartContainer(containerId);
        },
        deleteContainer: async containerId => {
            const { userApi } = await prepareUserRequest(undefined);
            await userApi.deleteContainer(containerId);
        },
    };
}
