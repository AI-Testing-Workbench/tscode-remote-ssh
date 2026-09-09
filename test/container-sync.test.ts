import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerConfig } from '../src/containerConfig';
import { ContainerSync, getHostFromEndpoint, getUniqueHostName } from '../src/containerSync';
import { ContainerOperationRegistry } from '../src/containerOperations';
import { RestClientError, UserRestApi } from '../src/api/restClient';
import { ContainerStatusResponse } from '../src/api/models';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    while (temporaryDirectories.length) {
        const directory = temporaryDirectories.pop();
        if (directory) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
});

describe('ContainerSync', () => {
    it('adds new remote containers, deduplicates IDs, and reports missing endpoints per container', async () => {
        const store = await createStore();
        const getContainerStatuses = vi.fn(async () => ({
            containers: [
                status('container-1', 'running', '10.0.0.1:22', 'alice', 'repo'),
                status('container-1', 'running', '10.0.0.1:22', 'alice', 'repo'),
                status('container-2', 'stopped', null, '', ''),
            ],
        }));
        const sync = createSync(store, { getContainerStatuses }, {
            skipKnownHostsCheck: true,
        });

        const result = await sync.sync();

        expect(getContainerStatuses).toHaveBeenCalledOnce();
        expect(result.changed).toBe(true);
        expect(result.containers).toEqual([
            {
                containerId: 'container-1',
                host: 'alice/repo',
                hostName: '10.0.0.1',
                port: 22,
                status: 'running',
                endpoint: '10.0.0.1:22',
                startedAt: undefined,
                expiresAt: undefined,
                containerType: null,
                novncUrl: null,
                remote: true,
            },
            {
                containerId: 'container-2',
                host: 'TestAgent Cloud 服务',
                status: 'stopped',
                endpoint: null,
                startedAt: undefined,
                expiresAt: undefined,
                containerType: null,
                novncUrl: null,
                remote: true,
                error: {
                    code: 'invalid_endpoint',
                    message: 'TestAgent Cloud 服务 endpoint 必须是 IP:Port',
                },
            },
        ]);

        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('Host alice/repo');
        expect(text).toContain('HostName 10.0.0.1');
        expect(text).toContain('User root');
        expect(text).not.toContain('container-2');
        expect(text).toContain('StrictHostKeyChecking no');
        expect(text).toContain('UserKnownHostsFile /dev/null');
    });

    it('writes the current SSH username when the username setting is blank', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'legacy', host: 'legacy-host' });
        await store.write(document);

        const sync = createSync(store, emptyBatch(), { userName: '' });

        await sync.sync();

        expect(await fs.readFile(store.filePath, 'utf8')).toContain(`User ${os.userInfo().username}`);
    });

    it('propagates API resource usage values, including unavailable metrics', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: [{
                    container_id: 'container-usage',
                    status: 'running',
                    endpoint: '10.0.0.4:22',
                    cpu_usage: 12.5,
                    memory_usage: null,
                    gitee_user: '',
                    gitee_repository: '',
                }],
            })),
        });

        const result = await sync.sync();

        expect(result.containers[0]).toMatchObject({
            cpuUsage: 12.5,
            memoryUsage: null,
        });
    });

    it('marks missing containers with ExpiresAt and removes it when they return', async () => {
        const store = await createStore();
        const initial = await store.read();
        store.upsertContainer(initial.config, { containerId: 'container-3', host: '10.0.0.3' });
        await store.write(initial);

        let present = false;
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: present
                    ? [status('container-3', 'running', '10.0.0.3:22', '', '')]
                    : [],
            })),
        }, {
            skipKnownHostsCheck: false,
        });

        const missing = await sync.sync();
        expect(missing.containers).toEqual([{
            containerId: 'container-3',
            host: '10.0.0.3',
            status: 'missing',
            expiresAt: '2026-09-01T00:00:00.000Z',
            remote: false,
        }]);
        expect((await fs.readFile(store.filePath, 'utf8'))).toContain('ExpiresAt 2026-09-01T00:00:00.000Z');

        present = true;
        const returned = await sync.sync();
        expect(returned.containers[0]).toMatchObject({
            containerId: 'container-3',
            host: 'TestAgent Cloud 服务',
            hostName: '10.0.0.3',
            port: 22,
            status: 'running',
            remote: true,
        });
        expect((await fs.readFile(store.filePath, 'utf8'))).not.toMatch(/^\s*ExpiresAt\s/m);
    });

    it('cleans only the oldest history entries and keeps all history when the limit is zero', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'oldest', host: '10.0.0.10', expiresAt: '2026-01-01T00:00:00.000Z' });
        store.upsertContainer(document.config, { containerId: 'middle', host: '10.0.0.11', expiresAt: '2026-02-01T00:00:00.000Z' });
        store.upsertContainer(document.config, { containerId: 'newest', host: '10.0.0.12', expiresAt: '2026-03-01T00:00:00.000Z' });
        await store.write(document);

        const userApi = {
            getContainerStatuses: vi.fn(async () => ({ containers: [] })),
        } as unknown as UserRestApi;
        const sync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: false,
                historyLimit: 2,
                statusSyncInterval: 5,
                debug: false,
                disableClientValidation: true,
            }),
            now: () => new Date('2026-09-01T00:00:00.000Z'),
        });

        await sync.sync();
        const afterCleanup = await store.read();
        expect(store.list(afterCleanup.config).map(entry => entry.containerId)).toEqual(['middle', 'newest']);

        const unlimitedSync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: false,
                historyLimit: 0,
                statusSyncInterval: 5,
                debug: false,
                disableClientValidation: true,
            }),
            now: () => new Date('2026-09-01T00:00:00.000Z'),
        });
        await unlimitedSync.sync();
        expect(store.list((await store.read()).config).map(entry => entry.containerId)).toEqual(['middle', 'newest']);
    });

    it('surfaces a batch status failure as a sync error', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => {
                throw new RestClientError('http', 'backend_error', 'TestAgent Cloud 服务异常', 502);
            }),
        });

        const result = await sync.sync();

        expect(result.error).toMatchObject({ code: 'backend_error' });
        expect(result.containers).toEqual([]);
    });

    it('does not call the API for an empty URL or empty user ID', async () => {
        const store = await createStore();
        const getContainerStatuses = vi.fn();
        const userApi = { getContainerStatuses } as unknown as UserRestApi;
        const emptyUrl = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            userApi,
            getSettings: () => ({ userName: 'root', backendApiUrl: '', skipKnownHostsCheck: true, historyLimit: 5, statusSyncInterval: 5, debug: false, disableClientValidation: true }),
        });
        expect((await emptyUrl.sync()).error?.code).toBe('api_url_missing');
        expect(getContainerStatuses).not.toHaveBeenCalled();

        const emptyUser = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: vi.fn(async () => '') },
            userApi,
            getSettings: () => ({ userName: 'root', backendApiUrl: 'http://api.example.test', skipKnownHostsCheck: true, historyLimit: 5, statusSyncInterval: 5, debug: false, disableClientValidation: true }),
        });
        expect((await emptyUser.sync()).error?.code).toBe('user_id_missing');
        expect(getContainerStatuses).not.toHaveBeenCalled();
    });

    it('creates unique descriptive Host aliases from Gitee fields', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: [
                    status('one', 'running', '10.0.0.1:22', 'alice', 'repo'),
                    status('two', 'running', '10.0.0.2:22', 'alice', 'repo'),
                    status('three', 'running', '10.0.0.3:22', '', ''),
                ],
            })),
        });

        const result = await sync.sync();

        expect(result.containers.map(container => container.host)).toEqual([
            'alice/repo',
            'alice/repo (1)',
            'TestAgent Cloud 服务',
        ]);
        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('Host alice/repo\n');
        expect(text).toContain('Host "alice/repo (1)"\n');
        expect(text).toContain('Host "TestAgent Cloud 服务"\n');
        expect((await store.read()).config.filter(line => line.type === 1 && 'config' in line)).toHaveLength(3);
    });

    it('repairs duplicate Host aliases already present in the config', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'one', host: 'alice/repo' });
        store.upsertContainer(document.config, { containerId: 'two', host: 'alice/repo' });
        await store.write(document);

        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: [
                    status('one', 'running', '10.0.0.1:22', 'alice', 'repo'),
                    status('two', 'running', '10.0.0.2:22', 'alice', 'repo'),
                ],
            })),
        });

        const result = await sync.sync();

        expect(result.containers.map(container => container.host)).toEqual([
            'alice/repo',
            'alice/repo (1)',
        ]);
        expect((await store.read()).config.filter(line => line.type === 1 && 'config' in line)).toHaveLength(2);
    });

    it('adds a suffix when an existing Host differs only by case or whitespace', () => {
        expect(getUniqueHostName('alice/repo', new Set([' Alice/Repo ']))).toBe('alice/repo (1)');
    });

    it('notifies once and skips new config entries for invalid endpoints', async () => {
        const store = await createStore();
        const onInvalidEndpoint = vi.fn();
        const sync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi: {
                getContainerStatuses: vi.fn(async () => ({
                    containers: [{
                        container_id: 'invalid',
                        status: 'running',
                        endpoint: 'example.com:22',
                        gitee_user: 'alice',
                        gitee_repository: 'repo',
                    }],
                })),
            } as unknown as UserRestApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: true,
                historyLimit: 5,
                statusSyncInterval: 5,
                debug: false,
                disableClientValidation: true,
            }),
            onInvalidEndpoint,
        });

        const first = await sync.sync();
        const second = await sync.sync();

        expect(first.containers[0]).toMatchObject({
            containerId: 'invalid',
            host: 'alice/repo',
            status: 'running',
            error: {
                code: 'invalid_endpoint',
            },
        });
        expect(second.containers[0]).toMatchObject({ error: { code: 'invalid_endpoint' } });
        expect(onInvalidEndpoint).toHaveBeenCalledOnce();
        expect(onInvalidEndpoint).toHaveBeenCalledWith({ containerId: 'invalid', endpoint: 'example.com:22' });
        expect((await fs.readFile(store.filePath, 'utf8'))).not.toContain('ContainerId invalid');
    });

    it('accepts and stores only the IP and port from a debug proxy endpoint when enabled', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: [{
                    container_id: 'debug-container',
                    status: 'running',
                    endpoint: '10.0.0.30:2200/proxy/XX',
                    gitee_user: 'alice',
                    gitee_repository: 'debug-repo',
                }],
            })),
        }, { debug: true });

        const result = await sync.sync();

        expect(result.containers[0]).toMatchObject({
            containerId: 'debug-container',
            host: 'alice/debug-repo',
            hostName: '10.0.0.30',
            port: 2200,
            status: 'running',
        });
        expect(result.containers[0].error).toBeUndefined();
        const text = await fs.readFile(store.filePath, 'utf8');
        expect(text).toContain('HostName 10.0.0.30');
        expect(text).toContain('Port 2200');
        expect(text).not.toContain('/proxy/XX');
    });

    it('coalesces concurrent sync calls', async () => {
        const store = await createStore();
        let resolveBatch: ((value: { containers: ContainerStatusResponse[] }) => void) | undefined;
        const getContainerStatuses = vi.fn(() => new Promise<{ containers: ContainerStatusResponse[] }>(resolve => {
            resolveBatch = resolve;
        }));
        const sync = createSync(store, { getContainerStatuses });

        const first = sync.sync();
        const second = sync.sync();
        expect(second).toBe(first);
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledOnce());
        expect(getContainerStatuses).toHaveBeenCalledOnce();
        resolveBatch?.({ containers: [] });
        await first;
    });

    it('starts one configured timer, performs an immediate sync, and clears the timer on dispose', async () => {
        vi.useFakeTimers();
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const store = await createStore();
        const getContainerStatuses = vi.fn(async () => ({ containers: [] }));
        const sync = createSync(store, { getContainerStatuses }, {
            backendApiUrl: 'http://api.example.test',
            statusSyncInterval: 2.5,
            debug: false,
        });

        sync.start();
        sync.start();
        expect(setIntervalSpy).toHaveBeenCalledOnce();
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledOnce());

        await vi.advanceTimersByTimeAsync(2500);
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledTimes(2));

        sync.dispose();
        expect(clearIntervalSpy).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getContainerStatuses).toHaveBeenCalledTimes(2);
    });

    it('does not notify the sidebar after an in-flight sync is disposed', async () => {
        const store = await createStore();
        let resolveBatch: ((value: { containers: ContainerStatusResponse[] }) => void) | undefined;
        const getContainerStatuses = vi.fn(() => new Promise<{ containers: ContainerStatusResponse[] }>(resolve => {
            resolveBatch = resolve;
        }));
        const onSync = vi.fn();
        const sync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi: {
                getContainerStatuses,
            } as unknown as UserRestApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: false,
                historyLimit: 5,
                statusSyncInterval: 5,
                debug: false,
                disableClientValidation: true,
            }),
            onSync,
        });

        const pending = sync.sync();
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledOnce());
        sync.dispose();
        resolveBatch?.({ containers: [] });
        await pending;
        expect(onSync).not.toHaveBeenCalled();
    });

    it('makes manual refresh use the same in-flight sync promise', async () => {
        const store = await createStore();
        const sync = createSync(store, emptyBatch(), { backendApiUrl: '' });

        const first = sync.sync();
        expect(sync.refresh()).toBe(first);
        await first;
    });

    it('runs a fresh sync after an in-flight sync for a mutation', async () => {
        const store = await createStore();
        const resolvers: Array<(value: { containers: ContainerStatusResponse[] }) => void> = [];
        const getContainerStatuses = vi.fn(() => new Promise<{ containers: ContainerStatusResponse[] }>(resolve => {
            resolvers.push(resolve);
        }));
        const sync = createSync(store, { getContainerStatuses });

        const first = sync.sync();
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledOnce());
        const forced = sync.refreshAfterMutation();
        expect(sync.refreshAfterMutation()).toBe(forced);
        expect(forced).not.toBe(first);

        resolvers.shift()?.({ containers: [] });
        await vi.waitFor(() => expect(getContainerStatuses).toHaveBeenCalledTimes(2));
        resolvers.shift()?.({ containers: [] });
        await first;
        await forced;
    });

    it('blocks synchronization while a mutation owns the config boundary', async () => {
        const store = await createStore();
        const getContainerStatuses = vi.fn(async () => ({ containers: [] }));
        const sync = createSync(store, { getContainerStatuses });
        let releaseMutation: (() => void) | undefined;
        let mutationStarted = false;
        const mutation = sync.runMutation(async () => {
            mutationStarted = true;
            await new Promise<void>(resolve => {
                releaseMutation = resolve;
            });
        });
        const waitingSync = sync.sync();

        await vi.waitFor(() => expect(mutationStarted).toBe(true));
        expect(getContainerStatuses).not.toHaveBeenCalled();
        releaseMutation?.();
        await mutation;
        await waitingSync;
        expect(getContainerStatuses).toHaveBeenCalledOnce();
    });

    it('suppresses a stale remote ID after local deletion until the cloud confirms removal', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, { containerId: 'deleted-1', host: 'deleted-host' });
        store.removeContainer(document.config, 'deleted-1');
        await store.write(document);

        let remoteIds = ['deleted-1'];
        const sync = createSync(store, {
            getContainerStatuses: vi.fn(async () => ({
                containers: remoteIds.map(id => status(id, 'running', '10.0.0.1:22', '', '')),
            })),
        });
        sync.markContainerDeleted('deleted-1');

        const stale = await sync.sync();
        expect(stale.containers).toEqual([]);
        expect(store.list((await store.read()).config)).toEqual([]);

        remoteIds = [];
        const confirmed = await sync.sync();
        expect(confirmed.containers).toEqual([]);
    });

    it('keeps an external lifecycle operation active until a fresh sync confirms the target state', async () => {
        const store = await createStore();
        let statusValue = 'running';
        const registry = new ContainerOperationRegistry();
        const getContainerStatuses = vi.fn(async () => ({
            containers: [status('container-1', statusValue, '10.0.0.1:22', '', '')],
        }));
        const sync = createSync(store, { getContainerStatuses }, {}, registry);
        registry.begin('container-1', 'stop', 'admin');

        await sync.sync();
        expect(registry.get('container-1')).toMatchObject({ phase: 'processing', action: 'stop' });

        registry.setPhase('container-1', 'reconciling');

        statusValue = 'stopped';
        await sync.sync();
        expect(getContainerStatuses).toHaveBeenCalled();
        expect(registry.get('container-1')).toBeUndefined();
    });

    it('does not confirm restore until a previously deleted local service returns remotely', async () => {
        const store = await createStore();
        const document = await store.read();
        store.upsertContainer(document.config, {
            containerId: 'container-restore',
            host: 'restore-host',
            expiresAt: '2026-09-01T00:00:00.000Z',
        });
        await store.write(document);

        let remote: ContainerStatusResponse[] = [];
        const registry = new ContainerOperationRegistry();
        const getContainerStatuses = vi.fn(async () => ({ containers: remote }));
        const sync = createSync(store, { getContainerStatuses }, {}, registry);
        registry.begin('container-restore', 'restore', 'admin');
        registry.setPhase('container-restore', 'reconciling');

        await sync.sync();
        expect(registry.get('container-restore')).toBeDefined();

        remote = [status('container-restore', 'running', '10.0.0.9:22', '', '')];
        await sync.sync();
        expect(registry.get('container-restore')).toBeUndefined();
    });
});

describe('getHostFromEndpoint', () => {
    it('extracts an initial host from common endpoint forms', () => {
        expect(getHostFromEndpoint('10.0.0.1')).toBeUndefined();
        expect(getHostFromEndpoint('10.0.0.1:22')).toBe('10.0.0.1');
        expect(getHostFromEndpoint('ssh://10.0.0.2:22')).toBeUndefined();
        expect(getHostFromEndpoint('[::1]:22')).toBe('::1');
        expect(getHostFromEndpoint(null)).toBeUndefined();
    });
});

async function createStore(): Promise<ContainerConfig> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-container-sync-'));
    temporaryDirectories.push(directory);
    return new ContainerConfig(path.join(directory, 'testagent'));
}

function status(
    containerId: string,
    statusValue: string,
    endpoint: string | null,
    giteeUser: string,
    giteeRepository: string,
): ContainerStatusResponse {
    return {
        container_id: containerId,
        status: statusValue,
        ...(endpoint !== null ? { endpoint } : { endpoint: null }),
        gitee_user: giteeUser,
        gitee_repository: giteeRepository,
    };
}

function emptyBatch(): Pick<UserRestApi, 'getContainerStatuses'> {
    return { getContainerStatuses: vi.fn(async () => ({ containers: [] })) };
}

function createSync(
    store: ContainerConfig,
    api: Pick<UserRestApi, 'getContainerStatuses'>,
    settings: Partial<ReturnType<NonNullable<ContainerSyncOptionsForTest['getSettings']>>> = {},
    operationRegistry?: ContainerOperationRegistry,
): ContainerSync {
    return new ContainerSync({
        config: store,
        userIdProvider: { getCurrentUserId: async () => 'user-1' },
        userApi: api as UserRestApi,
        getSettings: () => ({
            backendApiUrl: 'http://api.example.test',
            userName: 'root',
            skipKnownHostsCheck: true,
            historyLimit: 5,
            statusSyncInterval: 5,
            debug: false,
            disableClientValidation: true,
            ...settings,
        }),
        operationRegistry,
        now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
}

type ContainerSyncOptionsForTest = ConstructorParameters<typeof ContainerSync>[0];
