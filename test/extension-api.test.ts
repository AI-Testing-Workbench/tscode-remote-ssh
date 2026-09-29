import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPublicUserContainerApi,
    PUBLIC_API_ERROR_CODES,
    PublicApiCallbackError,
} from '../src/api/publicApi';
import { RestClientError, UserRestApi } from '../src/api/restClient';
import * as vscode from './mocks/vscode';

describe('public user container API', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vscode.window.showErrorMessage.mockReset();
        vscode.extensions.getExtension.mockReset();
    });

    it('exposes only the versioned user API methods and fills the current user ID internally', async () => {
        const userApi = createUserApi();
        const userIdProvider = { getCurrentUserId: vi.fn(async () => 'user-1') };
        const userApiFactory = vi.fn(() => userApi);
        const api = createPublicUserContainerApi({
            userIdProvider,
            getSettings: () => settings('https://api.example.test'),
            userApiFactory,
        });

        await api.createContainer({ plugin_id: 'example.plugin', gitee_user: 'Alice' });
        await api.getActiveServiceIds({ container_type: 'autotest_cloud' });
        await api.getContainer('service-1');
        await api.checkAdmin();
        await api.startContainer('service-1');
        await api.stopContainer('service-1');
        await api.restartContainer('service-1');
        await api.deleteContainer('service-1');

        expect(Object.keys(api).sort()).toEqual([
            'checkAdmin',
            'createContainer',
            'deleteContainer',
            'getActiveServiceIds',
            'getContainer',
            'restartContainer',
            'startContainer',
            'stopContainer',
            'syncFiles',
        ]);
        expect((api as unknown as Record<string, unknown>).admin).toBeUndefined();
        expect((api as unknown as Record<string, unknown>).getContainerIds).toBeUndefined();
        expect((api as unknown as Record<string, unknown>).filebrowser).toBeUndefined();
        expect((api as unknown as Record<string, unknown>).ssh).toBeUndefined();
        expect(userApi.createContainer).toHaveBeenCalledWith({
            gitee_user: 'Alice',
            user_id: 'user-1',
        });
        expect(userApi.getContainerStatuses).toHaveBeenCalledWith({
            container_type: 'autotest_cloud',
            user_id: 'user-1',
        });
        expect(userApi.getContainer).toHaveBeenCalledWith('service-1');
        expect(userApi.checkAdmin).toHaveBeenCalledWith({ user_id: 'user-1' });
        expect(userApi.startContainer).toHaveBeenCalledWith('service-1');
        expect(userApi.stopContainer).toHaveBeenCalledWith('service-1');
        expect(userApi.restartContainer).toHaveBeenCalledWith('service-1');
        expect(userApi.deleteContainer).toHaveBeenCalledWith('service-1');
        expect(userApiFactory).toHaveBeenCalledTimes(8);
        expect(userIdProvider.getCurrentUserId).toHaveBeenCalledTimes(8);
    });

    it('returns only running service IDs and removes duplicate status entries', async () => {
        const userApi = createUserApi();
        vi.mocked(userApi.getContainerStatuses).mockResolvedValue({
            containers: [
                { ...containerStatus('service-running-1', 'running'), container_id: 'physical-running-1' },
                { ...containerStatus('service-stopped-1', 'stopped'), container_id: 'physical-stopped-1' },
                { ...containerStatus('service-running-1', 'RUNNING'), container_id: 'physical-duplicate-1' },
                { ...containerStatus('service-pending-1', 'pending'), container_id: 'physical-pending-1' },
                { ...containerStatus('service-failed-1', 'failed'), container_id: 'physical-failed-1' },
                { ...containerStatus('service-unknown-1', 'unknown'), container_id: 'physical-unknown-1' },
            ] as never,
        });
        const api = createApi(userApi);

        await expect(api.getActiveServiceIds()).resolves.toEqual({
            service_ids: ['service-running-1'],
        });
    });

    it('rejects a missing current user before making a REST request', async () => {
        const userApiFactory = vi.fn(() => createUserApi());
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => '') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory,
        });

        await expect(api.getActiveServiceIds()).rejects.toMatchObject({
            name: 'PublicApiError',
            kind: 'configuration',
            code: PUBLIC_API_ERROR_CODES.USER_ID_MISSING,
            message: '未获取到当前用户 ID',
        });
        expect(userApiFactory).not.toHaveBeenCalled();
    });

    it('requires plugin_id and never sends plugin_id, callbacks, or a runtime user_id to REST', async () => {
        const userApi = createUserApi();
        const api = createApi(userApi);
        const callback = vi.fn();
        vi.mocked(userApi.createContainer).mockResolvedValue({
            service_id: 'service-created-1',
            container_id: 'physical-created-1',
            status: 'pending',
            plugin_id: 'echoed.plugin',
            user_id: 'echoed-user',
        } as never);

        await expect(api.createContainer({} as never)).rejects.toMatchObject({
            code: PUBLIC_API_ERROR_CODES.INVALID_ARGUMENT,
            message: 'plugin_id 不能为空',
        });
        const created = await api.createContainer({
            plugin_id: 'example.plugin',
            callbacks: { postCompleted: callback },
            user_id: 'attacker-user',
            gitee_repository: 'repo',
        } as never);

        expect(userApi.createContainer).toHaveBeenCalledWith({
            gitee_repository: 'repo',
            user_id: 'user-1',
        });
        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith('service-created-1');
        expect(created).not.toHaveProperty('plugin_id');
        expect(created).not.toHaveProperty('user_id');
        expect(created).not.toHaveProperty('container_id');
    });

    it('returns the admin limit mode through a zero-argument public method', async () => {
        const userApi = createUserApi();
        vi.mocked(userApi.checkAdmin).mockResolvedValue({ admin: false, limit: 'repository' });
        const api = createApi(userApi);

        await expect(api.checkAdmin()).resolves.toEqual({ admin: false, limit: 'repository' });
        expect(userApi.checkAdmin).toHaveBeenCalledWith({ user_id: 'user-1' });
    });

    it('waits for initialization and invokes each creation callback in order', async () => {
        const userApi = createUserApi();
        vi.mocked(userApi.createContainer).mockResolvedValue({
            service_id: 'service-created-1',
            container_id: 'physical-created-1',
            status: 'pending',
        } as never);
        const calls: string[] = [];
        const postCompleted = vi.fn((serviceId: string) => { calls.push(`postCompleted:${serviceId}`); });
        const gitInitialized = vi.fn((serviceId: string) => { calls.push(`gitInitialized:${serviceId}`); });
        const containerPrepared = vi.fn((serviceId: string) => { calls.push(`containerPrepared:${serviceId}`); });
        const initializationPoller = {
            initialize: vi.fn(async () => {
                calls.push('git-poll-start');
                return { container: containerStatus('service-created-1', 'running', 'initialized') };
            }),
        };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            initializationPoller,
        });

        await expect(api.createContainer({
            plugin_id: 'example.plugin',
            callbacks: {
                postCompleted,
                gitInitialized,
                containerPrepared,
            },
        })).resolves.toMatchObject({ status: 'running' });

        expect(calls).toEqual([
            'postCompleted:service-created-1',
            'git-poll-start',
            'gitInitialized:service-created-1',
            'containerPrepared:service-created-1',
        ]);
        expect(postCompleted).toHaveBeenCalledWith('service-created-1');
        expect(gitInitialized).toHaveBeenCalledWith('service-created-1');
        expect(containerPrepared).toHaveBeenCalledWith('service-created-1');
        expect(initializationPoller.initialize).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service-created-1' }));
        expect(initializationPoller.initialize).toHaveBeenCalledOnce();
        expect(userApi.deleteContainer).not.toHaveBeenCalled();
    });

    it('ignores the removed pre-response callback stage', async () => {
        const userApi = createUserApi();
        const postSent = vi.fn();
        const api = createApi(userApi);

        await api.createContainer({
            plugin_id: 'example.plugin',
            callbacks: { postSent } as never,
        });

        expect(postSent).not.toHaveBeenCalled();
    });

    it('deletes the created container exactly once when a callback fails and preserves both errors', async () => {
        const userApi = createUserApi();
        const callbackError = new Error('callback failed');
        const cleanupError = new Error('cleanup failed');
        vi.mocked(userApi.createContainer).mockResolvedValue({
            service_id: 'service-callback-failure',
            container_id: 'physical-callback-failure',
            status: 'pending',
        } as never);
        vi.mocked(userApi.deleteContainer).mockRejectedValue(cleanupError);
        vscode.extensions.getExtension.mockReturnValue({
            packageJSON: { displayName: 'Example Plugin' },
        } as never);
        const logger = { error: vi.fn() };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            logger,
        });

        const creating = api.createContainer({
            plugin_id: 'example.plugin',
            callbacks: { postCompleted: vi.fn(() => { throw callbackError; }) },
        });
        await expect(creating).rejects.toBeInstanceOf(PublicApiCallbackError);
        await expect(creating).rejects.toMatchObject({
            pluginId: 'example.plugin',
            pluginName: 'Example Plugin',
            stage: 'postCompleted',
            originalError: callbackError,
            cause: callbackError,
            cleanupError,
        });
        expect(userApi.deleteContainer).toHaveBeenCalledOnce();
        expect(userApi.deleteContainer).toHaveBeenCalledWith('service-callback-failure');
        expect(userApi.deleteContainer).not.toHaveBeenCalledWith('physical-callback-failure');
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Example Plugin'), expect.objectContaining({
            originalError: callbackError,
            cleanupError,
        }));
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('example.plugin'), { modal: true });
    });

    it('adds the configured Name to public status and falls back to Host for old entries', async () => {
        const userApi = createUserApi();
        vi.mocked(userApi.getContainer).mockResolvedValue({
            ...containerStatus('service-1', 'running'),
            container_id: 'physical-1',
            name: 'backend-name',
            user_id: 'backend-user',
        } as never);
        const config = {
            read: vi.fn(async () => ({ config: {} as never, originalText: '' })),
            list: vi.fn(() => [{ serviceId: 'service-1', host: 'legacy-host' }]),
        };
        const api = createPublicUserContainerApi({
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            getSettings: () => settings('https://api.example.test'),
            userApiFactory: () => userApi,
            containerConfig: config,
        });

        await expect(api.getContainer('service-1')).resolves.toMatchObject({ name: 'legacy-host' });
        await expect(api.getContainer('service-1')).resolves.not.toHaveProperty('user_id');
        await expect(api.getContainer('service-1')).resolves.not.toHaveProperty('container_id');
    });

    it('preserves REST errors for callers to identify', async () => {
        const restError = new RestClientError('http', 'container_conflict', '云端沙箱 服务冲突', 409);
        const userApi = createUserApi();
        vi.spyOn(userApi, 'createContainer').mockRejectedValue(restError);
        const api = createApi(userApi);

        await expect(api.createContainer({ plugin_id: 'example.plugin' })).rejects.toBe(restError);
    });
});

function createApi(userApi: UserRestApi) {
    return createPublicUserContainerApi({
        userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
        getSettings: () => settings('https://api.example.test'),
        userApiFactory: () => userApi,
    });
}

function createUserApi(): UserRestApi {
    return {
        createContainer: vi.fn(async () => ({ service_id: 'service-1', status: 'pending' })),
        getServiceIds: vi.fn(async () => ({ service_ids: ['service-1'] })),
        getContainerStatuses: vi.fn(async () => ({ containers: [] })),
        getContainer: vi.fn(async () => containerStatus('service-1', 'running')),
        checkAdmin: vi.fn(async () => ({ admin: false, limit: 'user' as const })),
        startContainer: vi.fn(async () => undefined),
        stopContainer: vi.fn(async () => undefined),
        restartContainer: vi.fn(async () => undefined),
        deleteContainer: vi.fn(async () => undefined),
    };
}

function containerStatus(serviceId: string, status: string, git_fin_status?: string) {
    return {
        service_id: serviceId,
        status,
        ...(git_fin_status ? { git_fin_status } : {}),
        gitee_user: '',
        gitee_repository: '',
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
