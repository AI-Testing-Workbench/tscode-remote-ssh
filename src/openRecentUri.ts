import * as vscode from 'vscode';
import { openRemoteSSHLocationWindow } from './commands';
import { ContainerConfig, type ContainerConfigEntry } from './containerConfig';
import { formatContainerEndpoint, parseContainerEndpoint } from './containerEndpoint';
import type { Log } from './common/logger';
import type { RemoteLocationHistory } from './remoteLocationHistory';
import type { ContainerSync, ContainerSyncResult } from './containerSync';
import SSHDestination from './ssh/sshDestination';

const OPEN_PATH = '/open';
const DIR_PARAM = 'dir';
const SERVICE_ID_PARAM = 'serviceId';
const uriConnectionsInProgress = new Set<string>();

export interface OpenUriHandlerDependencies {
    history: RemoteLocationHistory;
    logger: Log;
    sync: Pick<ContainerSync, 'refresh'>;
    config: Pick<ContainerConfig, 'read' | 'list'>;
    isHostAvailable?: (host: string) => boolean;
    isOperationInProgress: (serviceId: string) => boolean;
    connect: (host: string, giteeRepository?: string) => Promise<boolean>;
}

export interface RemoteLocation {
    host: string;
    path: string;
}

export function parseTargetDirectory(query: string): string | undefined {
    const dir = new URLSearchParams(query).get(DIR_PARAM)?.trim();
    return dir || undefined;
}

/**
 * Finds the most specific recorded remote workspace that contains (or equals)
 * the requested directory. Records are keyed by the ssh host (alias) and hold
 * the workspace paths previously opened on that host. Stale aliases that no
 * longer exist in the local container config are ignored.
 */
export function findRemoteLocation(
    history: Record<string, string[]>,
    dir: string,
    isHostAvailable?: (host: string) => boolean,
): RemoteLocation | undefined {
    const target = normalize(dir);
    if (!target) {
        return undefined;
    }

    let best: RemoteLocation | undefined;
    for (const [host, paths] of Object.entries(history)) {
        if (isHostAvailable && !isHostAvailable(host)) {
            continue;
        }
        for (const path of paths) {
            const workspace = normalize(path);
            if (!workspace || !contains(target, workspace)) {
                continue;
            }
            if (!best || workspace.length > best.path.length) {
                best = { host, path: workspace };
            }
        }
    }
    return best;
}

export async function handleOpenRecentUri(
    uri: vscode.Uri,
    history: RemoteLocationHistory,
    logger?: Log,
    isHostAvailable?: (host: string) => boolean,
): Promise<void> {
    if (uri.path !== OPEN_PATH) {
        return;
    }

    const dir = parseTargetDirectory(uri.query);
    if (!dir) {
        return;
    }

    const predicate = isHostAvailable ?? await createAvailabilityPredicate(logger);
    const match = findRemoteLocation(history.all(), dir, predicate);
    if (!match) {
        void vscode.window.showWarningMessage('当前工作区在本地没有打开记录，无法直接连入云端。');
        return;
    }

    const host = SSHDestination.parse(match.host).toEncodedString();
    await openRemoteSSHLocationWindow(host, match.path, true);
}

export async function handleOpenUri(uri: vscode.Uri, dependencies: OpenUriHandlerDependencies): Promise<void> {
    if (uri.path !== OPEN_PATH) {
        return;
    }

    const params = new URLSearchParams(uri.query);
    if (params.has(DIR_PARAM)) {
        await handleOpenRecentUri(
            uri,
            dependencies.history,
            dependencies.logger,
            dependencies.isHostAvailable,
        );
        return;
    }

    if (!params.has(SERVICE_ID_PARAM)) {
        return;
    }

    const serviceId = params.get(SERVICE_ID_PARAM)?.trim();
    if (!serviceId) {
        dependencies.logger.error('URI serviceId 参数为空');
        return;
    }

    await handleOpenServiceUri(serviceId, dependencies);
}

async function handleOpenServiceUri(serviceId: string, dependencies: OpenUriHandlerDependencies): Promise<void> {
    if (uriConnectionsInProgress.has(serviceId) || dependencies.isOperationInProgress(serviceId)) {
        dependencies.logger.error(`URI 服务 ${serviceId} 当前已有操作，忽略重复连接`);
        return;
    }

    uriConnectionsInProgress.add(serviceId);
    try {
        await openServiceUri(serviceId, dependencies);
    } catch (error) {
        dependencies.logger.error(`URI 服务 ${serviceId} 处理失败`, error);
    } finally {
        uriConnectionsInProgress.delete(serviceId);
    }
}

async function openServiceUri(serviceId: string, dependencies: OpenUriHandlerDependencies): Promise<void> {
    let result: ContainerSyncResult;
    try {
        result = await dependencies.sync.refresh({ suppressInvalidEndpointNotifications: true });
    } catch (error) {
        dependencies.logger.error(`URI 服务 ${serviceId} 状态刷新失败`, error);
        return;
    }
    if (result.error) {
        dependencies.logger.error(`URI 服务 ${serviceId} 状态刷新失败`, result.error);
        return;
    }

    const container = result.containers.find(item => item.serviceId === serviceId);
    if (!container?.remote) {
        dependencies.logger.error(`URI 服务 ${serviceId} 不存在或已删除`);
        return;
    }
    if (container.error) {
        dependencies.logger.error(`URI 服务 ${serviceId} 当前不可连接`, container.error);
        return;
    }
    if (container.status.toLowerCase() !== 'running') {
        dependencies.logger.error(`URI 服务 ${serviceId} 状态为 ${container.status}，不是 running`);
        return;
    }

    let entry: ContainerConfigEntry | undefined;
    try {
        const document = await dependencies.config.read();
        entry = dependencies.config.list(document.config)
            .find(item => item.serviceId === serviceId && !item.expiresAt);
    } catch (error) {
        dependencies.logger.error(`URI 服务 ${serviceId} 的本地配置读取失败`, error);
        return;
    }

    if (!entry?.host.trim()) {
        dependencies.logger.error(`URI 服务 ${serviceId} 没有有效的本地 Host 配置`);
        return;
    }

    const endpoint = entry.hostName && entry.port !== undefined
        ? formatContainerEndpoint(entry.hostName, entry.port)
        : undefined;
    if (!parseContainerEndpoint(endpoint)) {
        dependencies.logger.error(`URI 服务 ${serviceId} 的 endpoint 无效：${endpoint ?? '(空)'}`);
        return;
    }
    if (dependencies.isOperationInProgress(serviceId)) {
        dependencies.logger.error(`URI 服务 ${serviceId} 在状态刷新期间开始了其他操作，忽略连接`);
        return;
    }

    try {
        await dependencies.connect(entry.host.trim(), container.giteeRepository?.trim() || undefined);
    } catch (error) {
        // The SSH resolver owns user-facing connection errors; keep this callback quiet.
        dependencies.logger.error(`URI 服务 ${serviceId} 连接失败`, error);
    }
}

async function createAvailabilityPredicate(logger?: Log): Promise<((host: string) => boolean) | undefined> {
    try {
        const config = new ContainerConfig();
        const document = await config.read();
        const available = new Set(config.list(document.config)
            .filter(entry => !entry.expiresAt)
            .map(entry => entry.host.trim().toLowerCase())
            .filter(Boolean));
        return host => available.has(host.trim().toLowerCase());
    } catch (error) {
        logger?.error('读取本地云端服务配置失败，按已有记录直接连接', error);
        return undefined;
    }
}

function contains(target: string, workspace: string): boolean {
    return target === workspace || target.startsWith(`${workspace}/`);
}

function normalize(path: string): string {
    return path.trim().replace(/\/+$/, '');
}
