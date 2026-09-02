import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerConfig } from '../src/containerConfig';
import { ContainerSync, getHostFromEndpoint } from '../src/containerSync';
import { RestClientError, UserRestApi } from '../src/api/restClient';

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
        const getContainerIds = vi.fn(async () => ({ container_ids: ['container-1', 'container-1', 'container-2'] }));
        const getContainer = vi.fn(async (containerId: string) => ({
            container_id: containerId,
            status: containerId === 'container-1' ? 'running' : 'stopped',
            endpoint: containerId === 'container-1' ? '10.0.0.1:22' : null,
            gitee_user: containerId === 'container-1' ? 'alice' : '',
            gitee_repository: containerId === 'container-1' ? 'repo' : '',
        }));
        const sync = createSync(store, { getContainerIds, getContainer }, {
            skipKnownHostsCheck: true,
        });

        const result = await sync.sync();

        expect(getContainerIds).toHaveBeenCalledOnce();
        expect(getContainer).toHaveBeenCalledTimes(2);
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
                remote: true,
            },
            {
                containerId: 'container-2',
                host: 'TestAgent Cloud 服务',
                status: 'stopped',
                endpoint: null,
                startedAt: undefined,
                expiresAt: undefined,
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

        const sync = createSync(store, {
            getContainerIds: vi.fn(async () => ({ container_ids: [] })),
            getContainer: vi.fn(),
        }, { userName: '' });

        await sync.sync();

        expect(await fs.readFile(store.filePath, 'utf8')).toContain(`User ${os.userInfo().username}`);
    });

    it('marks missing containers with ExpiresAt and removes it when they return', async () => {
        const store = await createStore();
        const initial = await store.read();
        store.upsertContainer(initial.config, { containerId: 'container-3', host: '10.0.0.3' });
        await store.write(initial);

        let present = false;
        const sync = createSync(store, {
            getContainerIds: vi.fn(async () => ({ container_ids: present ? ['container-3'] : [] })),
            getContainer: vi.fn(async () => ({
                container_id: 'container-3',
                status: 'running',
                endpoint: '10.0.0.3:22',
                gitee_user: '',
                gitee_repository: '',
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
            getContainerIds: vi.fn(async () => ({ container_ids: [] })),
            getContainer: vi.fn(),
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
            }),
            now: () => new Date('2026-09-01T00:00:00.000Z'),
        });
        await unlimitedSync.sync();
        expect(store.list((await store.read()).config).map(entry => entry.containerId)).toEqual(['middle', 'newest']);
    });

    it('isolates status failures and preserves the rest of the sync', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerIds: vi.fn(async () => ({ container_ids: ['missing-status', 'healthy'] })),
            getContainer: vi.fn(async (containerId: string) => {
                if (containerId === 'missing-status') {
                    throw new RestClientError('http', 'container_not_found', 'TestAgent Cloud 服务不存在', 404);
                }
                return {
                    container_id: containerId,
                    status: 'running',
                    endpoint: '10.0.0.20:22',
                    gitee_user: 'alice',
                    gitee_repository: 'healthy',
                };
            }),
        });

        const result = await sync.sync();

        expect(result.error).toBeUndefined();
        expect(result.containers).toEqual([
            {
                containerId: 'missing-status',
                host: 'TestAgent Cloud 服务',
                status: 'unknown',
                endpoint: undefined,
                startedAt: undefined,
                expiresAt: undefined,
                remote: true,
                error: {
                    code: 'container_not_found',
                    message: 'TestAgent Cloud 服务不存在',
                },
            },
            {
                containerId: 'healthy',
                host: 'alice/healthy',
                hostName: '10.0.0.20',
                port: 22,
                status: 'running',
                endpoint: '10.0.0.20:22',
                startedAt: undefined,
                expiresAt: undefined,
                remote: true,
            },
        ]);
        expect((await fs.readFile(store.filePath, 'utf8'))).toContain('ContainerId healthy');
    });

    it('does not call the API for an empty URL or empty user ID', async () => {
        const store = await createStore();
        const getContainerIds = vi.fn(async () => ({ container_ids: [] }));
        const userApi = { getContainerIds } as unknown as UserRestApi;
        const emptyUrl = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: vi.fn(async () => 'user-1') },
            userApi,
            getSettings: () => ({ userName: 'root', backendApiUrl: '', skipKnownHostsCheck: true, historyLimit: 5, statusSyncInterval: 5, debug: false }),
        });
        expect((await emptyUrl.sync()).error?.code).toBe('api_url_missing');
        expect(getContainerIds).not.toHaveBeenCalled();

        const emptyUser = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: vi.fn(async () => '') },
            userApi,
            getSettings: () => ({ userName: 'root', backendApiUrl: 'http://api.example.test', skipKnownHostsCheck: true, historyLimit: 5, statusSyncInterval: 5, debug: false }),
        });
        expect((await emptyUser.sync()).error?.code).toBe('user_id_missing');
        expect(getContainerIds).not.toHaveBeenCalled();
    });

    it('creates unique descriptive Host aliases from Gitee fields', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerIds: vi.fn(async () => ({ container_ids: ['one', 'two', 'three'] })),
            getContainer: vi.fn(async (containerId: string) => ({
                container_id: containerId,
                status: 'running',
                endpoint: `10.0.0.${containerId === 'one' ? '1' : containerId === 'two' ? '2' : '3'}:22`,
                gitee_user: containerId === 'three' ? '' : 'alice',
                gitee_repository: containerId === 'three' ? '' : 'repo',
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

    it('notifies once and skips new config entries for invalid endpoints', async () => {
        const store = await createStore();
        const onInvalidEndpoint = vi.fn();
        const sync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi: {
                getContainerIds: vi.fn(async () => ({ container_ids: ['invalid'] })),
                getContainer: vi.fn(async () => ({
                    container_id: 'invalid',
                    status: 'running',
                    endpoint: 'example.com:22',
                    gitee_user: 'alice',
                    gitee_repository: 'repo',
                })),
            } as unknown as UserRestApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: true,
                historyLimit: 5,
                statusSyncInterval: 5,
                debug: false,
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
            getContainerIds: vi.fn(async () => ({ container_ids: ['debug-container'] })),
            getContainer: vi.fn(async () => ({
                container_id: 'debug-container',
                status: 'running',
                endpoint: '10.0.0.30:2200/proxy/XX',
                gitee_user: 'alice',
                gitee_repository: 'debug-repo',
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
        let resolveIds: ((value: { container_ids: string[] }) => void) | undefined;
        const getContainerIds = vi.fn(() => new Promise<{ container_ids: string[] }>(resolve => {
            resolveIds = resolve;
        }));
        const sync = createSync(store, {
            getContainerIds,
            getContainer: vi.fn(),
        });

        const first = sync.sync();
        const second = sync.sync();
        expect(second).toBe(first);
        await vi.waitFor(() => expect(getContainerIds).toHaveBeenCalledOnce());
        expect(getContainerIds).toHaveBeenCalledOnce();
        resolveIds?.({ container_ids: [] });
        await first;
    });

    it('starts one configured timer, performs an immediate sync, and clears the timer on dispose', async () => {
        vi.useFakeTimers();
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const store = await createStore();
        const getContainerIds = vi.fn(async () => ({ container_ids: [] }));
        const sync = createSync(store, {
            getContainerIds,
            getContainer: vi.fn(),
        }, {
            backendApiUrl: '',
            statusSyncInterval: 2.5,
            debug: false,
        });

        sync.start();
        sync.start();
        expect(setIntervalSpy).toHaveBeenCalledOnce();
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
        await vi.waitFor(() => expect(getContainerIds).not.toHaveBeenCalled());

        sync.dispose();
        expect(clearIntervalSpy).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getContainerIds).not.toHaveBeenCalled();
    });

    it('does not notify the sidebar after an in-flight sync is disposed', async () => {
        const store = await createStore();
        let resolveIds: ((value: { container_ids: string[] }) => void) | undefined;
        const getContainerIds = vi.fn(() => new Promise<{ container_ids: string[] }>(resolve => {
            resolveIds = resolve;
        }));
        const onSync = vi.fn();
        const sync = new ContainerSync({
            config: store,
            userIdProvider: { getCurrentUserId: async () => 'user-1' },
            userApi: {
                getContainerIds,
                getContainer: vi.fn(),
            } as unknown as UserRestApi,
            getSettings: () => ({
                backendApiUrl: 'http://api.example.test',
                userName: 'root',
                skipKnownHostsCheck: false,
                historyLimit: 5,
                statusSyncInterval: 5,
                debug: false,
            }),
            onSync,
        });

        const pending = sync.sync();
        await vi.waitFor(() => expect(getContainerIds).toHaveBeenCalledOnce());
        sync.dispose();
        resolveIds?.({ container_ids: [] });
        await pending;
        expect(onSync).not.toHaveBeenCalled();
    });

    it('uses the configured interval once, runs an immediate check, and clears it on dispose', async () => {
        vi.useFakeTimers();
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const store = await createStore();
        const getContainerIds = vi.fn(async () => ({ container_ids: [] }));
        const sync = createSync(store, {
            getContainerIds,
            getContainer: vi.fn(),
        }, {
            backendApiUrl: '',
            statusSyncInterval: 2.5,
            debug: false,
        });

        sync.start();
        sync.start();
        expect(setIntervalSpy).toHaveBeenCalledOnce();
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2500);
        await Promise.resolve();
        expect(getContainerIds).not.toHaveBeenCalled();

        sync.dispose();
        expect(clearIntervalSpy).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(getContainerIds).not.toHaveBeenCalled();
    });

    it('makes manual refresh use the same in-flight sync promise', async () => {
        const store = await createStore();
        const sync = createSync(store, {
            getContainerIds: vi.fn(async () => ({ container_ids: [] })),
            getContainer: vi.fn(),
        }, { backendApiUrl: '' });

        const first = sync.sync();
        expect(sync.refresh()).toBe(first);
        await first;
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

function createSync(
    store: ContainerConfig,
    api: Pick<UserRestApi, 'getContainerIds' | 'getContainer'>,
    settings: Partial<ReturnType<NonNullable<ContainerSyncOptionsForTest['getSettings']>>> = {},
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
            ...settings,
        }),
        now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
}

type ContainerSyncOptionsForTest = ConstructorParameters<typeof ContainerSync>[0];
