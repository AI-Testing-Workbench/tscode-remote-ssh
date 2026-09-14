import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPublicUserContainerApi,
    PUBLIC_API_ERROR_CODES,
} from '../src/api/publicApi';
import { RestClientError, UserRestApi } from '../src/api/restClient';

describe('public user container API', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('exposes only user container methods and fills the current user ID', async () => {
        const userApi = createUserApi();
        const userIdProvider = { getCurrentUserId: vi.fn(async () => 'user-1') };
        const userApiFactory = vi.fn(() => userApi);
        const api = createPublicUserContainerApi({
            userIdProvider,
            getSettings: () => settings('https://api.example.test'),
            userApiFactory,
        });

        await api.createContainer({
            gitee_user: 'Alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            authorize_general_account: true,
        });
        await api.getContainerIds({
            container_type: 'autotest_cloud',
            gitee_user: 'Alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
        });
        await api.getContainer('container-1');
        await api.startContainer('container-1');
        await api.stopContainer('container-1');
        await api.restartContainer('container-1');
        await api.deleteContainer('container-1');

        expect(Object.keys(api).sort()).toEqual([
            'createContainer',
            'deleteContainer',
            'getContainer',
            'getContainerIds',
            'restartContainer',
            'startContainer',
            'stopContainer',
        ]);
        expect((api as unknown as Record<string, unknown>).checkAdmin).toBeUndefined();
        expect(userApi.createContainer).toHaveBeenCalledWith({
            gitee_user: 'Alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            authorize_general_account: true,
            user_id: 'user-1',
        });
        expect(userApi.getContainerIds).toHaveBeenCalledWith({
            container_type: 'autotest_cloud',
            gitee_user: 'Alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            user_id: 'user-1',
        });
        expect(userApi.getContainer).toHaveBeenCalledWith('container-1');
        expect(userApi.startContainer).toHaveBeenCalledWith('container-1');
        expect(userApi.stopContainer).toHaveBeenCalledWith('container-1');
        expect(userApi.restartContainer).toHaveBeenCalledWith('container-1');
        expect(userApi.deleteContainer).toHaveBeenCalledWith('container-1');
        expect(userApiFactory).toHaveBeenCalledTimes(7);
        expect(userIdProvider.getCurrentUserId).toHaveBeenCalledTimes(7);
    });

    it('rejects a missing current user before making a REST request', async () => {
        const userApiFactory = vi.fn(() => createUserApi());
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => '') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory,
        });

        await expect(api.getContainerIds()).rejects.toMatchObject({
            name: 'PublicApiError',
            kind: 'configuration',
            code: PUBLIC_API_ERROR_CODES.USER_ID_MISSING,
            message: '未获取到当前用户 ID',
        });
        expect(userApiFactory).not.toHaveBeenCalled();
    });

    it('rejects an empty or different caller user ID instead of overriding it', async () => {
        const userApiFactory = vi.fn(() => createUserApi());
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory,
        });

        await expect(api.createContainer({ user_id: '' })).rejects.toMatchObject({
            code: PUBLIC_API_ERROR_CODES.USER_ID_MISMATCH,
            message: 'user_id 不能为空',
        });
        await expect(api.getContainerIds({ user_id: 'user-2' })).rejects.toMatchObject({
            code: PUBLIC_API_ERROR_CODES.USER_ID_MISMATCH,
            message: 'user_id 必须与当前用户 ID一致',
        });
        expect(userApiFactory).not.toHaveBeenCalled();
    });

    it('preserves API URL and REST errors for callers to identify', async () => {
        const missingUrlApi = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings(''),
        });
        await expect(missingUrlApi.getContainerIds()).rejects.toMatchObject({
            name: 'RestClientError',
            kind: 'configuration',
            code: 'api_url_missing',
            message: '未配置后端 云端沙箱 管理服务的 API 地址',
        });

        const restError = new RestClientError('http', 'container_conflict', '云端沙箱 服务冲突', 409);
        const userApi = createUserApi();
        vi.spyOn(userApi, 'createContainer').mockRejectedValue(restError);
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
        });

        await expect(api.createContainer({})).rejects.toBe(restError);
    });

    it('waits for 码云 initialization before returning from public creation', async () => {
        const userApi = createUserApi();
        const initializationPoller = {
            initialize: vi.fn(async () => ({ gitStatus: 'initialized' as const })),
        };
        const userIdProvider = { getCurrentUserId: vi.fn(async () => 'user-1') };
        const api = createPublicUserContainerApi({
            userIdProvider,
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });

        await api.createContainer({ gitee_user: 'alice' });

        expect(initializationPoller.initialize).toHaveBeenCalledWith(expect.objectContaining({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
            statusReader: userApi,
        }));
        expect(userApi.getContainer).not.toHaveBeenCalled();
        await api.getContainer('container-1');
        expect(initializationPoller.initialize).toHaveBeenCalledOnce();
    });

    it('returns the final container status from public creation initialization', async () => {
        const userApi = createUserApi();
        const initializationPoller = {
            initialize: vi.fn(async () => ({
                containerId: 'container-1',
                serviceId: 'service-1',
                operatorUserId: 'user-1',
                container: {
                    container_id: 'container-1',
                    status: 'running',
                    type: 'autotest_cloud',
                    novnc_url: 'http://10.0.0.1:6080',
                    endpoint: '10.0.0.1:2222',
                    gitee_user: '',
                    gitee_repository: '',
                },
                gitStatus: 'initialized' as const,
                attempts: 2,
            })),
        };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });

        await expect(api.createContainer({})).resolves.toMatchObject({
            container_id: 'container-1',
            service_id: 'service-1',
            status: 'running',
            type: 'autotest_cloud',
            novnc_url: 'http://10.0.0.1:6080',
            endpoint: '10.0.0.1:2222',
        });
    });

    it('does not resolve public creation until the initialization promise settles', async () => {
        const userApi = createUserApi();
        let resolveInitialization: (() => void) | undefined;
        const initialization = new Promise<void>(resolve => {
            resolveInitialization = resolve;
        });
        const initializationPoller = { initialize: vi.fn(() => initialization) };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });

        let settled = false;
        const creating = api.createContainer({});
        creating.then(() => {
            settled = true;
        });
        await vi.waitFor(() => expect(initializationPoller.initialize).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveInitialization?.();
        await expect(creating).resolves.toMatchObject({ service_id: 'service-1' });
    });

    it('does not return a newly created public service when initialization fails', async () => {
        const userApi = createUserApi();
        const initializationError = new Error('git initialization failed');
        const initializationPoller = { initialize: vi.fn(async () => { throw initializationError; }) };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });

        await expect(api.createContainer({})).rejects.toBe(initializationError);
        expect(initializationPoller.initialize).toHaveBeenCalledOnce();
    });
});

function createUserApi(): UserRestApi {
    return {
        createContainer: vi.fn(async () => ({ container_id: 'container-1', service_id: 'service-1', status: 'pending' })),
        getContainerIds: vi.fn(async () => ({ container_ids: ['container-1'] })),
        getContainerStatuses: vi.fn(async () => ({ containers: [] })),
        getContainer: vi.fn(async () => ({
            container_id: 'container-1',
            status: 'running',
            gitee_user: '',
            gitee_repository: '',
        })),
        checkAdmin: vi.fn(async () => ({ admin: false })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
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
