import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper } from 'ssh2';
import type { FileEntry, Stats } from 'ssh2-streams';
import type { ContainerConfig, ContainerConfigEntry } from '../containerConfig';
import type { ContainerStatusResponse, FileSyncResult, PublicFileSyncConflict, PublicFileSyncDirection } from './models';

export interface FileSyncRunner {
    syncFiles(
        source: string,
        target: string,
        conflict?: PublicFileSyncConflict,
        mirror?: boolean,
    ): Promise<FileSyncResult>;
}

export interface SftpSession {
    sftp: SFTPWrapper;
    dispose?: () => Promise<void> | void;
}

export type SftpProvider = (entry: ContainerConfigEntry) => Promise<SftpSession>;
export type ServiceStatusReader = (serviceId: string) => Promise<Pick<ContainerStatusResponse, 'status'>>;

export interface FileSyncServiceOptions {
    config: Pick<ContainerConfig, 'read' | 'list'>;
    getContainerStatus: ServiceStatusReader;
    sftpProvider?: SftpProvider;
}

export type SyncPath = LocalSyncPath | RemoteSyncPath;

export interface LocalSyncPath {
    kind: 'local';
    path: string;
}

export interface RemoteSyncPath {
    kind: 'remote';
    serviceId: string;
    path: string;
}

export type FileSyncErrorCode =
    | 'invalid_path'
    | 'same_endpoint'
    | 'service_id_invalid'
    | 'service_not_configured'
    | 'config_read_failed'
    | 'service_status_failed'
    | 'service_not_running'
    | 'sftp_unavailable'
    | 'mirror_requires_directory'
    | 'unsupported_file_type'
    | 'transfer_failed';

export class FileSyncError extends Error {
    public constructor(
        public readonly code: FileSyncErrorCode,
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'FileSyncError';
    }
}

const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;
const FILE_TYPE = 0o100000;
const SYMBOLIC_LINK_TYPE = 0o120000;

export function parseSyncPath(value: string): SyncPath {
    if (typeof value !== 'string' || !value.trim() || hasControlCharacter(value)) {
        throw new FileSyncError('invalid_path', '同步路径必须是非空绝对路径');
    }

    const normalized = value.trim();
    if (isLocalAbsolutePath(normalized)) {
        return {
            kind: 'local',
            path: path.normalize(normalized),
        };
    }

    const separatorIndex = normalized.indexOf(':');
    if (separatorIndex === 0) {
        throw new FileSyncError('service_id_invalid', '远端路径中的服务 ID 不能为空');
    }
    if (separatorIndex < 0) {
        throw new FileSyncError('invalid_path', '远端路径必须使用 serviceId:/absolute/path 格式');
    }
    const serviceId = normalized.slice(0, separatorIndex);
    const remotePath = normalized.slice(separatorIndex + 1);
    if (!serviceId.trim()) {
        throw new FileSyncError('service_id_invalid', '远端路径中的服务 ID 不能为空');
    }
    if (!remotePath.startsWith('/')) {
        throw new FileSyncError('invalid_path', '远端路径必须使用 serviceId:/absolute/path 格式');
    }
    if (remotePath.includes('\\') || remotePath.split('/').includes('..')) {
        throw new FileSyncError('invalid_path', '远端路径不能包含路径穿越片段');
    }

    return {
        kind: 'remote',
        serviceId,
        path: path.posix.normalize(remotePath),
    };
}

export function getRemoteServiceId(source: string, target: string): string {
    const sourcePath = parseSyncPath(source);
    const targetPath = parseSyncPath(target);
    if (sourcePath.kind === targetPath.kind) {
        throw new FileSyncError('same_endpoint', '同步源和目标必须分别位于本地与远端');
    }
    if (sourcePath.kind === 'remote') {
        return sourcePath.serviceId;
    }
    if (targetPath.kind === 'remote') {
        return targetPath.serviceId;
    }
    throw new FileSyncError('same_endpoint', '同步源和目标必须分别位于本地与远端');
}

export class FileSyncService implements FileSyncRunner {
    private readonly config: Pick<ContainerConfig, 'read' | 'list'>;
    private readonly getContainerStatus: ServiceStatusReader;
    private readonly sftpProvider: SftpProvider | undefined;

    public constructor(options: FileSyncServiceOptions) {
        this.config = options.config;
        this.getContainerStatus = options.getContainerStatus;
        this.sftpProvider = options.sftpProvider;
    }

    public async syncFiles(
        source: string,
        target: string,
        conflict: PublicFileSyncConflict = 'overwrite',
        mirror = false,
    ): Promise<FileSyncResult> {
        if (conflict !== 'overwrite' && conflict !== 'skip') {
            throw new FileSyncError('invalid_path', '冲突策略必须是 overwrite 或 skip');
        }

        const sourcePath = parseSyncPath(source);
        const targetPath = parseSyncPath(target);
        if (sourcePath.kind === targetPath.kind) {
            throw new FileSyncError('same_endpoint', '同步源和目标必须分别位于本地与远端');
        }

        const remotePath = sourcePath.kind === 'remote'
            ? sourcePath
            : targetPath.kind === 'remote'
                ? targetPath
                : undefined;
        if (!remotePath) {
            throw new FileSyncError('same_endpoint', '同步源和目标必须分别位于本地与远端');
        }
        const document = await this.readConfig();
        const entry = this.config.list(document.config).find(item => item.serviceId === remotePath.serviceId);
        if (!entry) {
            throw new FileSyncError(
                'service_not_configured',
                `服务 "${remotePath.serviceId}" 未在 SSH 配置中登记`,
            );
        }

        let status: Pick<ContainerStatusResponse, 'status'>;
        try {
            status = await this.getContainerStatus(remotePath.serviceId);
        } catch (error) {
            throw new FileSyncError(
                'service_status_failed',
                `无法读取服务 "${remotePath.serviceId}" 的运行状态`,
                error,
            );
        }
        if (typeof status?.status !== 'string' || status.status.trim().toLowerCase() !== 'running') {
            throw new FileSyncError(
                'service_not_running',
                `服务 "${remotePath.serviceId}" 当前未处于 running 状态`,
            );
        }
        if (!this.sftpProvider) {
            throw new FileSyncError('sftp_unavailable', '当前没有可用的 SSH SFTP 连接');
        }

        let session: SftpSession;
        try {
            session = await this.sftpProvider(entry);
        } catch (error) {
            throw new FileSyncError(
                'sftp_unavailable',
                `无法连接服务 "${remotePath.serviceId}" 的 SFTP 服务`,
                error,
            );
        }

        const counter = new SyncCounter(
            sourcePath.kind === 'remote' ? 'download' : 'upload',
        );
        try {
            if (sourcePath.kind === 'local') {
                await this.upload(sourcePath.path, targetPath.path, session.sftp, conflict, mirror, counter);
            } else {
                await this.download(sourcePath.path, targetPath.path, session.sftp, conflict, mirror, counter);
            }
            return counter.result();
        } catch (error) {
            if (error instanceof FileSyncError) {
                throw error;
            }
            throw new FileSyncError('transfer_failed', '文件同步失败', error);
        } finally {
            try {
                if (session.dispose) {
                    await session.dispose();
                } else if (typeof session.sftp.end === 'function') {
                    session.sftp.end();
                }
            } catch {
                // Transfer failures must remain the primary error.
            }
        }
    }

    private async upload(
        localRoot: string,
        remoteRoot: string,
        sftp: SFTPWrapper,
        conflict: PublicFileSyncConflict,
        mirror: boolean,
        counter: SyncCounter,
    ): Promise<void> {
        await assertLocalParentsSafe(localRoot);
        const sourceInfo = await getLocalNodeInfo(localRoot);
        assertDirectoryAllowed(sourceInfo, localRoot);
        if (mirror && sourceInfo.kind !== 'directory') {
            throw new FileSyncError('mirror_requires_directory', 'mirror 模式要求同步源是目录');
        }

        await assertRemoteParentsSafe(sftp, remoteRoot);
        const targetInfo = await getRemoteNodeInfo(sftp, remoteRoot);
        if (sourceInfo.kind === 'directory') {
            if (targetInfo && targetInfo.kind !== 'directory') {
                if (conflict === 'skip') {
                    counter.skipped += 1;
                    return;
                }
                await removeRemoteNode(sftp, remoteRoot, targetInfo);
            }
            const created = !targetInfo;
            await ensureRemoteDirectory(sftp, remoteRoot);
            if (created) {
                counter.copied += 1;
            }
            await this.uploadDirectory(localRoot, remoteRoot, sftp, conflict, counter);
            if (mirror) {
                await mirrorRemoteDirectory(sftp, remoteRoot, localRoot, counter);
            }
            return;
        }

        if (targetInfo && conflict === 'skip') {
            counter.skipped += 1;
            return;
        }
        if (targetInfo && targetInfo.kind === 'directory') {
            await removeRemoteNode(sftp, remoteRoot, targetInfo);
        }
        await ensureRemoteParent(sftp, remoteRoot);
        await uploadFile(localRoot, remoteRoot, sftp, targetInfo !== undefined && targetInfo.kind !== 'directory', counter);
    }

    private async uploadDirectory(
        localDirectory: string,
        remoteDirectory: string,
        sftp: SFTPWrapper,
        conflict: PublicFileSyncConflict,
        counter: SyncCounter,
    ): Promise<void> {
        const children = await fsPromises.readdir(localDirectory, { withFileTypes: true });
        for (const child of children) {
            const localPath = path.join(localDirectory, child.name);
            const remotePath = path.posix.join(remoteDirectory, child.name);
            const sourceInfo = await getLocalNodeInfo(localPath);
            assertDirectoryAllowed(sourceInfo, localPath);
            const targetInfo = await getRemoteNodeInfo(sftp, remotePath);
            if (sourceInfo.kind === 'directory') {
                if (targetInfo && targetInfo.kind !== 'directory') {
                    if (conflict === 'skip') {
                        counter.skipped += 1;
                        continue;
                    }
                    await removeRemoteNode(sftp, remotePath, targetInfo);
                }
                const created = !targetInfo;
                await ensureRemoteDirectory(sftp, remotePath);
                if (created) {
                    counter.copied += 1;
                }
                await this.uploadDirectory(localPath, remotePath, sftp, conflict, counter);
                continue;
            }
            if (targetInfo && conflict === 'skip') {
                counter.skipped += 1;
                continue;
            }
            if (targetInfo && targetInfo.kind === 'directory') {
                await removeRemoteNode(sftp, remotePath, targetInfo);
            }
            await ensureRemoteParent(sftp, remotePath);
            await uploadFile(localPath, remotePath, sftp, targetInfo !== undefined && targetInfo.kind !== 'directory', counter);
        }
    }

    private async download(
        remoteRoot: string,
        localRoot: string,
        sftp: SFTPWrapper,
        conflict: PublicFileSyncConflict,
        mirror: boolean,
        counter: SyncCounter,
    ): Promise<void> {
        await assertRemoteParentsSafe(sftp, remoteRoot);
        const sourceInfo = await getRemoteNodeInfo(sftp, remoteRoot);
        if (!sourceInfo) {
            throw new FileSyncError('transfer_failed', `远端路径不存在: ${remoteRoot}`);
        }
        assertDirectoryAllowed(sourceInfo, remoteRoot);
        if (mirror && sourceInfo.kind !== 'directory') {
            throw new FileSyncError('mirror_requires_directory', 'mirror 模式要求同步源是目录');
        }

        const targetInfo = await getLocalNodeInfo(localRoot, true);
        if (sourceInfo.kind === 'directory') {
            if (targetInfo && targetInfo.kind !== 'directory') {
                if (conflict === 'skip') {
                    counter.skipped += 1;
                    return;
                }
                await removeLocalNode(localRoot, targetInfo);
            }
            const created = !targetInfo;
            await ensureLocalDirectory(localRoot);
            if (created) {
                counter.copied += 1;
            }
            await this.downloadDirectory(remoteRoot, localRoot, sftp, conflict, counter);
            if (mirror) {
                await mirrorLocalDirectory(localRoot, remoteRoot, sftp, counter);
            }
            return;
        }

        if (targetInfo && conflict === 'skip') {
            counter.skipped += 1;
            return;
        }
        if (targetInfo && targetInfo.kind === 'directory') {
            await removeLocalNode(localRoot, targetInfo);
        }
        await ensureLocalParent(localRoot);
        await downloadFile(remoteRoot, localRoot, sftp, targetInfo !== undefined && targetInfo.kind !== 'directory', counter);
    }

    private async downloadDirectory(
        remoteDirectory: string,
        localDirectory: string,
        sftp: SFTPWrapper,
        conflict: PublicFileSyncConflict,
        counter: SyncCounter,
    ): Promise<void> {
        const children = await sftpReaddir(sftp, remoteDirectory);
        for (const child of children) {
            const name = getRemoteEntryName(child);
            assertRemoteEntryName(name);
            if (!name || name === '.' || name === '..') {
                continue;
            }
            const remotePath = path.posix.join(remoteDirectory, name);
            const localPath = path.join(localDirectory, name);
            const sourceInfo = await getRemoteNodeInfo(sftp, remotePath);
            if (!sourceInfo) {
                continue;
            }
            assertDirectoryAllowed(sourceInfo, remotePath);
            const targetInfo = await getLocalNodeInfo(localPath, true);
            if (sourceInfo.kind === 'directory') {
                if (targetInfo && targetInfo.kind !== 'directory') {
                    if (conflict === 'skip') {
                        counter.skipped += 1;
                        continue;
                    }
                    await removeLocalNode(localPath, targetInfo);
                }
                const created = !targetInfo;
                await ensureLocalDirectory(localPath);
                if (created) {
                    counter.copied += 1;
                }
                await this.downloadDirectory(remotePath, localPath, sftp, conflict, counter);
                continue;
            }
            if (targetInfo && conflict === 'skip') {
                counter.skipped += 1;
                continue;
            }
            if (targetInfo && targetInfo.kind === 'directory') {
                await removeLocalNode(localPath, targetInfo);
            }
            await ensureLocalParent(localPath);
            await downloadFile(remotePath, localPath, sftp, targetInfo !== undefined && targetInfo.kind !== 'directory', counter);
        }
    }

    private async readConfig(): Promise<Awaited<ReturnType<ContainerConfig['read']>>> {
        try {
            return await this.config.read();
        } catch (error) {
            throw new FileSyncError('config_read_failed', '读取 SSH 配置失败', error);
        }
    }
}

class SyncCounter {
    public copied = 0;
    public skipped = 0;
    public deleted = 0;
    public bytesTransferred = 0;

    public constructor(private readonly direction: PublicFileSyncDirection) {
    }

    public result(): FileSyncResult {
        return {
            direction: this.direction,
            copied: this.copied,
            skipped: this.skipped,
            deleted: this.deleted,
            bytesTransferred: this.bytesTransferred,
            complete: this.skipped === 0,
        };
    }
}

interface NodeInfo {
    kind: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
}

async function getLocalNodeInfo(filePath: string, missingOkay = false): Promise<NodeInfo | undefined> {
    try {
        const stats = await fsPromises.lstat(filePath);
        return {
            kind: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
            size: stats.size,
        };
    } catch (error) {
        if (missingOkay && isNotFound(error)) {
            return undefined;
        }
        throw error;
    }
}

async function getRemoteNodeInfo(sftp: SFTPWrapper, remotePath: string): Promise<NodeInfo | undefined> {
    try {
        const stats = await sftpLstat(sftp, remotePath);
        return remoteNodeInfo(stats);
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }
        throw error;
    }
}

function remoteNodeInfo(stats: Stats): NodeInfo {
    if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
        return { kind: 'symlink', size: stats.size };
    }
    if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
        return { kind: 'directory', size: stats.size };
    }
    if (typeof stats.isFile === 'function' && stats.isFile()) {
        return { kind: 'file', size: stats.size };
    }
    const mode = typeof stats.mode === 'number' ? stats.mode : 0;
    const type = mode & FILE_TYPE_MASK;
    return {
        kind: type === SYMBOLIC_LINK_TYPE ? 'symlink' : type === DIRECTORY_TYPE ? 'directory' : type === FILE_TYPE ? 'file' : 'other',
        size: typeof stats.size === 'number' ? stats.size : 0,
    };
}

function assertDirectoryAllowed(info: NodeInfo | undefined, filePath: string): asserts info is NodeInfo {
    if (!info) {
        throw new FileSyncError('transfer_failed', `同步路径不存在: ${filePath}`);
    }
    if (info.kind === 'symlink') {
        throw new FileSyncError('unsupported_file_type', `同步路径不能是符号链接: ${filePath}`);
    }
    if (info.kind === 'other') {
        throw new FileSyncError('unsupported_file_type', `同步路径不是普通文件或目录: ${filePath}`);
    }
}

async function uploadFile(
    localPath: string,
    remotePath: string,
    sftp: SFTPWrapper,
    hasExistingTarget: boolean,
    counter: SyncCounter,
): Promise<void> {
    const temporaryPath = makeRemoteTemporaryPath(remotePath);
    let complete = false;
    let bytes = 0;
    try {
        const readable = fs.createReadStream(localPath);
        readable.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
        });
        const writable = sftp.createWriteStream(temporaryPath, { flags: 'wx' });
        await pipeline(readable, writable);
        await replaceRemoteFile(sftp, temporaryPath, remotePath, hasExistingTarget);
        complete = true;
        counter.copied += 1;
        counter.bytesTransferred += bytes;
    } finally {
        if (!complete) {
            await unlinkRemoteIfPresent(sftp, temporaryPath);
        }
    }
}

async function downloadFile(
    remotePath: string,
    localPath: string,
    sftp: SFTPWrapper,
    hasExistingTarget: boolean,
    counter: SyncCounter,
): Promise<void> {
    const temporaryPath = makeLocalTemporaryPath(localPath);
    let complete = false;
    let bytes = 0;
    try {
        const readable = sftp.createReadStream(remotePath);
        readable.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
        });
        const writable = fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
        await pipeline(readable, writable);
        await replaceLocalFile(temporaryPath, localPath, hasExistingTarget);
        complete = true;
        counter.copied += 1;
        counter.bytesTransferred += bytes;
    } finally {
        if (!complete) {
            await unlinkLocalIfPresent(temporaryPath);
        }
    }
}

async function ensureRemoteParent(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    await assertRemoteParentsSafe(sftp, remotePath);
    await ensureRemoteDirectory(sftp, path.posix.dirname(remotePath));
}

async function assertRemoteParentsSafe(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    let current = path.posix.dirname(path.posix.normalize(remotePath));
    while (current && current !== '/') {
        const info = await getRemoteNodeInfo(sftp, current);
        if (info) {
            if (info.kind === 'symlink') {
                throw new FileSyncError('unsupported_file_type', `远端路径父目录不能是符号链接: ${current}`);
            }
            if (info.kind !== 'directory') {
                throw new FileSyncError('unsupported_file_type', `远端路径父项不是目录: ${current}`);
            }
        }
        current = path.posix.dirname(current);
    }
}

async function ensureRemoteDirectory(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    const normalized = path.posix.normalize(remotePath);
    if (normalized === '/') {
        return;
    }
    const existing = await getRemoteNodeInfo(sftp, normalized);
    if (existing) {
        if (existing.kind !== 'directory') {
            throw new FileSyncError('unsupported_file_type', `远端父路径不是目录: ${normalized}`);
        }
        return;
    }
    await ensureRemoteDirectory(sftp, path.posix.dirname(normalized));
    try {
        await sftpMkdir(sftp, normalized);
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
    }
}

async function ensureLocalParent(localPath: string): Promise<void> {
    await ensureLocalDirectory(path.dirname(localPath));
}

async function ensureLocalDirectory(localPath: string): Promise<void> {
    await assertLocalParentsSafe(localPath);
    const existing = await getLocalNodeInfo(localPath, true);
    if (existing) {
        if (existing.kind !== 'directory') {
            throw new FileSyncError('unsupported_file_type', `本地父路径不是目录: ${localPath}`);
        }
        return;
    }
    await fsPromises.mkdir(localPath, { recursive: true, mode: 0o700 });
}

async function assertLocalParentsSafe(localPath: string): Promise<void> {
    let current = path.dirname(localPath);
    const root = path.parse(current).root;
    while (current && current !== root) {
        try {
            const stats = await fsPromises.lstat(current);
            if (stats.isSymbolicLink()) {
                throw new FileSyncError('unsupported_file_type', `本地路径父目录不能是符号链接: ${current}`);
            }
            if (!stats.isDirectory()) {
                throw new FileSyncError('unsupported_file_type', `本地路径父项不是目录: ${current}`);
            }
            current = path.dirname(current);
        } catch (error) {
            if (isNotFound(error)) {
                current = path.dirname(current);
                continue;
            }
            throw error;
        }
    }
}

async function removeLocalNode(localPath: string, info: NodeInfo): Promise<void> {
    if (info.kind === 'directory') {
        const children = await fsPromises.readdir(localPath, { withFileTypes: true });
        for (const child of children) {
            const childPath = path.join(localPath, child.name);
            const childInfo = await getLocalNodeInfo(childPath);
            if (childInfo) {
                await removeLocalNode(childPath, childInfo);
            }
        }
        await fsPromises.rmdir(localPath);
        return;
    }
    await fsPromises.unlink(localPath);
}

async function removeRemoteNode(sftp: SFTPWrapper, remotePath: string, info: NodeInfo): Promise<void> {
    if (info.kind === 'directory') {
        const children = await sftpReaddir(sftp, remotePath);
        for (const child of children) {
            const name = getRemoteEntryName(child);
            assertRemoteEntryName(name);
            if (!name || name === '.' || name === '..') {
                continue;
            }
            const childPath = path.posix.join(remotePath, name);
            const childInfo = await getRemoteNodeInfo(sftp, childPath);
            if (childInfo) {
                await removeRemoteNode(sftp, childPath, childInfo);
            }
        }
        await sftpRmdir(sftp, remotePath);
        return;
    }
    await sftpUnlink(sftp, remotePath);
}

async function mirrorRemoteDirectory(
    sftp: SFTPWrapper,
    remoteDirectory: string,
    localDirectory: string,
    counter: SyncCounter,
): Promise<void> {
    const sourceNames = new Set((await fsPromises.readdir(localDirectory)).map(name => name.toString()));
    const children = await sftpReaddir(sftp, remoteDirectory);
    for (const child of children) {
        const name = getRemoteEntryName(child);
        if (!name || name === '.' || name === '..' || sourceNames.has(name)) {
            continue;
        }
        const remotePath = path.posix.join(remoteDirectory, name);
        const info = await getRemoteNodeInfo(sftp, remotePath);
        if (info) {
            await removeRemoteNode(sftp, remotePath, info);
            counter.deleted += 1;
        }
    }
}

async function mirrorLocalDirectory(
    localDirectory: string,
    remoteDirectory: string,
    sftp: SFTPWrapper,
    counter: SyncCounter,
): Promise<void> {
    const sourceNames = new Set((await sftpReaddir(sftp, remoteDirectory))
        .map(getRemoteEntryName)
        .filter((name): name is string => {
            assertRemoteEntryName(name);
            return Boolean(name);
        }));
    const children = await fsPromises.readdir(localDirectory);
    for (const name of children) {
        if (sourceNames.has(name)) {
            continue;
        }
        const localPath = path.join(localDirectory, name);
        const info = await getLocalNodeInfo(localPath);
        if (info) {
            await removeLocalNode(localPath, info);
            counter.deleted += 1;
        }
    }
}

async function replaceRemoteFile(
    sftp: SFTPWrapper,
    temporaryPath: string,
    targetPath: string,
    hasExistingTarget: boolean,
): Promise<void> {
    if (!hasExistingTarget) {
        await sftpRename(sftp, temporaryPath, targetPath);
        return;
    }
    const backupPath = makeRemoteBackupPath(targetPath);
    let backedUp = false;
    try {
        await sftpRename(sftp, targetPath, backupPath);
        backedUp = true;
        await sftpRename(sftp, temporaryPath, targetPath);
        await unlinkRemoteIfPresent(sftp, backupPath);
    } catch (error) {
        if (backedUp) {
            try {
                await sftpRename(sftp, backupPath, targetPath);
            } catch {
                // Preserve the transfer error; the backup is still visible for recovery.
            }
        }
        throw error;
    }
}

async function replaceLocalFile(
    temporaryPath: string,
    targetPath: string,
    hasExistingTarget: boolean,
): Promise<void> {
    if (!hasExistingTarget) {
        await fsPromises.rename(temporaryPath, targetPath);
        return;
    }
    const backupPath = makeLocalBackupPath(targetPath);
    let backedUp = false;
    try {
        await fsPromises.rename(targetPath, backupPath);
        backedUp = true;
        await fsPromises.rename(temporaryPath, targetPath);
        await unlinkLocalIfPresent(backupPath);
    } catch (error) {
        if (backedUp) {
            try {
                await fsPromises.rename(backupPath, targetPath);
            } catch {
                // Preserve the transfer error; the backup is still visible for recovery.
            }
        }
        throw error;
    }
}

function makeRemoteTemporaryPath(targetPath: string): string {
    return `${path.posix.dirname(targetPath)}/.${path.posix.basename(targetPath)}.testagent-sync-${randomSuffix()}.tmp`;
}

function makeRemoteBackupPath(targetPath: string): string {
    return `${path.posix.dirname(targetPath)}/.${path.posix.basename(targetPath)}.testagent-sync-${randomSuffix()}.bak`;
}

function makeLocalTemporaryPath(targetPath: string): string {
    return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.testagent-sync-${randomSuffix()}.tmp`);
}

function makeLocalBackupPath(targetPath: string): string {
    return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.testagent-sync-${randomSuffix()}.bak`);
}

function randomSuffix(): string {
    return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isLocalAbsolutePath(value: string): boolean {
    return value.startsWith('/') || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('\\\\');
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}

function isNotFound(error: unknown): boolean {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'SSH_FX_NO_SUCH_FILE' || code === '2') {
        return true;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
    return message.includes('no such file') || message.includes('not found');
}

function isAlreadyExists(error: unknown): boolean {
    const code = getErrorCode(error);
    if (code === 'EEXIST' || code === 'SSH_FX_FILE_ALREADY_EXISTS' || code === '11') {
        return true;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
    return message.includes('already exists') || message.includes('file already exists');
}

function getErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        if (typeof error.code === 'string') {
            return error.code;
        }
        if (typeof error.code === 'number') {
            return String(error.code);
        }
    }
    return undefined;
}

function getRemoteEntryName(entry: FileEntry): string {
    return typeof entry.filename === 'string' ? entry.filename : '';
}

function assertRemoteEntryName(name: string): void {
    if (!name || hasControlCharacter(name) || name.includes('/') || name.includes('\\')) {
        throw new FileSyncError('invalid_path', '远端目录返回了无效的文件名');
    }
}

function callbackRequest<T>(invoke: (callback: (error: unknown, value?: T) => void) => unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const callback = (error: unknown, value?: T): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error);
            } else {
                resolve(value as T);
            }
        };
        try {
            const result = invoke(callback);
            if (isPromiseLike(result)) {
                result.then(value => callback(undefined, value as T), error => callback(error));
            }
        } catch (error) {
            callback(error);
        }
    });
}

function sftpLstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
    return callbackRequest<Stats>(callback => sftp.lstat(remotePath, callback));
}

function sftpReaddir(sftp: SFTPWrapper, remotePath: string): Promise<FileEntry[]> {
    return callbackRequest<FileEntry[]>(callback => sftp.readdir(remotePath, callback));
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return callbackRequest<void>(callback => sftp.mkdir(remotePath, callback));
}

function sftpUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return callbackRequest<void>(callback => sftp.unlink(remotePath, callback));
}

function sftpRmdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return callbackRequest<void>(callback => sftp.rmdir(remotePath, callback));
}

function sftpRename(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
    return callbackRequest<void>(callback => sftp.rename(oldPath, newPath, callback));
}

async function unlinkRemoteIfPresent(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    try {
        await sftpUnlink(sftp, remotePath);
    } catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
    }
}

async function unlinkLocalIfPresent(localPath: string): Promise<void> {
    try {
        await fsPromises.unlink(localPath);
    } catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
