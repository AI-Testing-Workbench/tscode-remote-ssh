import * as vscode from 'vscode';
import { openRemoteSSHLocationWindow } from './commands';
import { ContainerConfig } from './containerConfig';
import type { Log } from './common/logger';
import type { RemoteLocationHistory } from './remoteLocationHistory';
import SSHDestination from './ssh/sshDestination';

const OPEN_PATH = '/open';
const DIR_PARAM = 'dir';

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
