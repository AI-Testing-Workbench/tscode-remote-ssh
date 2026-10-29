import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from './mocks/vscode';
import {
    findRemoteLocation,
    handleOpenRecentUri,
    handleOpenUri,
    parseTargetDirectory,
    type OpenUriHandlerDependencies,
} from '../src/openRecentUri';
import type { ContainerConfigEntry } from '../src/containerConfig';
import type { ContainerSyncResult, SyncedContainer } from '../src/containerSync';

class FakeHistory {
    constructor(private readonly entries: Record<string, string[]>) {
    }

    all(): Record<string, string[]> {
        return this.entries;
    }
}

type UriLike = Parameters<typeof handleOpenRecentUri>[0];
type HistoryLike = Parameters<typeof handleOpenRecentUri>[1];

function fakeUri(path: string, query: string): UriLike {
    return { path, query } as UriLike;
}

function makeServiceUriDependencies(options: {
    result?: ContainerSyncResult;
    entries?: ContainerConfigEntry[];
    readError?: Error;
    busy?: boolean;
    connect?: OpenUriHandlerDependencies['connect'];
} = {}) {
    let refreshCount = 0;
    let configReadCount = 0;
    let refreshOptions: unknown;
    const connections: Array<{ host: string; repository?: string }> = [];
    const logs: unknown[][] = [];
    const container: SyncedContainer = {
        serviceId: 'service-1',
        host: 'ignored-host',
        status: 'running',
        remote: true,
        giteeRepository: 'owner/repository',
    };
    const result = options.result ?? { containers: [container], changed: false };
    const entries = options.entries ?? [{
        serviceId: 'service-1',
        host: 'service-host',
        hostName: '192.0.2.10',
        port: 2222,
    }];
    const dependencies: OpenUriHandlerDependencies = {
        history: new FakeHistory({}) as unknown as HistoryLike,
        logger: {
            trace: () => undefined,
            info: () => undefined,
            error: (...args: unknown[]) => logs.push(args),
        } as unknown as NonNullable<OpenUriHandlerDependencies['logger']>,
        isHostAvailable: () => true,
        sync: {
            refresh: async optionsForRefresh => {
                refreshCount += 1;
                refreshOptions = optionsForRefresh;
                return result;
            },
        },
        config: {
            read: async () => {
                configReadCount += 1;
                if (options.readError) {
                    throw options.readError;
                }
                return { config: [] as never, originalText: '' };
            },
            list: () => entries,
        },
        isOperationInProgress: () => options.busy ?? false,
        connect: options.connect ?? (async (host, repository) => {
            connections.push({ host, repository });
            return true;
        }),
    };
    return {
        dependencies,
        connections,
        logs,
        refreshCount: () => refreshCount,
        configReadCount: () => configReadCount,
        refreshOptions: () => refreshOptions,
    };
}

describe('parseTargetDirectory', () => {
    it('reads and decodes the dir parameter', () => {
        expect(parseTargetDirectory('dir=%2Fapp%2Fmy-repo&other=1')).toBe('/app/my-repo');
    });

    it('returns undefined when missing or blank', () => {
        expect(parseTargetDirectory('')).toBeUndefined();
        expect(parseTargetDirectory('dir=%20%20')).toBeUndefined();
    });
});

describe('findRemoteLocation', () => {
    const history = {
        'alice/repo': ['/app/repo'],
        'bob/other': ['/app/other'],
    };

    it('matches an exact recorded workspace', () => {
        expect(findRemoteLocation(history, '/app/repo')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('matches when the requested directory is inside the recorded workspace', () => {
        expect(findRemoteLocation(history, '/app/repo/packages/cli')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('ignores trailing slashes', () => {
        expect(findRemoteLocation(history, '/app/repo/')).toEqual({ host: 'alice/repo', path: '/app/repo' });
    });

    it('prefers the most specific recorded workspace', () => {
        const nested = {
            'alice/repo': ['/app'],
            'alice/repo-mono': ['/app/repo'],
        };
        expect(findRemoteLocation(nested, '/app/repo/cli')).toEqual({ host: 'alice/repo-mono', path: '/app/repo' });
    });

    it('does not match a recorded workspace outside the requested directory', () => {
        expect(findRemoteLocation(history, '/app')).toBeUndefined();
    });

    it('returns undefined without a usable directory', () => {
        expect(findRemoteLocation(history, '')).toBeUndefined();
    });

    it('ignores aliases that are no longer available', () => {
        expect(findRemoteLocation(history, '/app/repo', host => host === 'bob/other')).toBeUndefined();
    });
});

describe('handleOpenRecentUri', () => {
    beforeEach(() => {
        vscode.commands.executeCommand.mockReset();
    });

    it('opens the recorded remote workspace in the current window', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp%2Frepo%2Fcli'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
        const [command, target, options] = vscode.commands.executeCommand.mock.calls[0];
        expect(command).toBe('vscode.openFolder');
        expect(target).toMatchObject({ scheme: 'vscode-remote', path: '/app/repo' });
        expect((target as { authority: string }).authority).toContain('ssh-remote+');
        expect(options).toEqual({ forceNewWindow: false, noRecentEntry: true });
    });

    it('does nothing when there is no matching record', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp%2Fmissing'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it('skips stale records whose host is no longer configured', async () => {
        const history = new FakeHistory({ 'stale/host': ['/app'], 'alice/repo': ['/app'] });

        await handleOpenRecentUri(fakeUri('/open', 'dir=%2Fapp'), history as unknown as HistoryLike, undefined, host => host === 'alice/repo');

        const [, target] = vscode.commands.executeCommand.mock.calls[0];
        expect(target).toMatchObject({ path: '/app' });
        expect((target as { authority: string }).authority).not.toContain('stale');
    });

    it('ignores unrelated paths', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });

        await handleOpenRecentUri(fakeUri('/other', 'dir=%2Fapp%2Frepo'), history as unknown as HistoryLike, undefined, () => true);

        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});

describe('handleOpenUri', () => {
    beforeEach(() => {
        vscode.commands.executeCommand.mockReset();
        vscode.window.showWarningMessage.mockReset();
    });

    it('keeps dir precedence and ignores serviceId when both are provided', async () => {
        const history = new FakeHistory({ 'alice/repo': ['/app/repo'] });
        const service = makeServiceUriDependencies();

        await handleOpenUri(
            fakeUri('/open', 'dir=%2Fapp%2Frepo%2Fchild&serviceId=service-1'),
            { ...service.dependencies, history: history as unknown as HistoryLike },
        );

        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
        expect(vscode.commands.executeCommand.mock.calls[0][1]).toMatchObject({ path: '/app/repo' });
        expect(service.refreshCount()).toBe(0);
        expect(service.connections).toHaveLength(0);
    });

    it('refreshes, validates, and connects an active service by ID', async () => {
        const service = makeServiceUriDependencies();

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.refreshCount()).toBe(1);
        expect(service.refreshOptions()).toEqual({ suppressInvalidEndpointNotifications: true });
        expect(service.configReadCount()).toBe(1);
        expect(service.connections).toEqual([{ host: 'service-host', repository: 'owner/repository' }]);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs and quietly stops when service refresh fails', async () => {
        const service = makeServiceUriDependencies({
            result: {
                containers: [],
                changed: false,
                error: { code: 'sync_failed', message: 'offline' },
            },
        });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.configReadCount()).toBe(0);
        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs and quietly stops when the service is not running', async () => {
        const service = makeServiceUriDependencies({
            result: {
                containers: [{
                    serviceId: 'service-1',
                    host: 'ignored-host',
                    status: 'stopped',
                    remote: true,
                }],
                changed: false,
            },
        });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.configReadCount()).toBe(0);
        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs config read failures without connecting or notifying the user', async () => {
        const service = makeServiceUriDependencies({ readError: new Error('permission denied') });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs blank service IDs and does not refresh', async () => {
        const service = makeServiceUriDependencies();

        await handleOpenUri(fakeUri('/open', 'serviceId=%20%20'), service.dependencies);

        expect(service.refreshCount()).toBe(0);
        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs and skips expired Host entries', async () => {
        const service = makeServiceUriDependencies({
            entries: [{
                serviceId: 'service-1',
                host: 'service-host',
                hostName: '192.0.2.10',
                port: 2222,
                expiresAt: '2026-10-29T00:00:00.000Z',
            }],
        });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('logs and stops before refreshing when a service operation is active', async () => {
        const service = makeServiceUriDependencies({ busy: true });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.refreshCount()).toBe(0);
        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
    });

    it('logs invalid endpoints and does not connect', async () => {
        const service = makeServiceUriDependencies({
            entries: [{ serviceId: 'service-1', host: 'service-host', hostName: 'example.com', port: 22 }],
        });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.connections).toHaveLength(0);
        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('blocks duplicate service ID callbacks while a connection is pending', async () => {
        let signalConnected: () => void = () => undefined;
        let releaseConnection: () => void = () => undefined;
        let connectCount = 0;
        const connected = new Promise<void>(resolve => {
            signalConnected = resolve;
        });
        const connectionGate = new Promise<void>(resolve => {
            releaseConnection = resolve;
        });
        const service = makeServiceUriDependencies({
            connect: async () => {
                connectCount += 1;
                signalConnected();
                await connectionGate;
                return true;
            },
        });

        const first = handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);
        await connected;
        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);
        releaseConnection();
        await first;

        expect(connectCount).toBe(1);
        expect(service.refreshCount()).toBe(1);
        expect(service.logs).toHaveLength(1);
    });

    it('logs connection rejections without showing another notification', async () => {
        const service = makeServiceUriDependencies({
            connect: async () => {
                throw new Error('resolver rejected the connection');
            },
        });

        await handleOpenUri(fakeUri('/open', 'serviceId=service-1'), service.dependencies);

        expect(service.logs).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
});
