import * as fs from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SSHConfig from 'ssh-config';
import type { SFTPWrapper } from 'ssh2';
import { FileSyncError, FileSyncService, getRemoteServiceId, parseSyncPath } from '../src/api/fileSync';

const temporaryDirectories: string[] = [];
const SERVICE_ID = 'service+opaque-7f2a';
const PHYSICAL_CONTAINER_ID = 'container-physical-94bd';

afterEach(async () => {
    while (temporaryDirectories.length) {
        const directory = temporaryDirectories.pop();
        if (directory) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
});

describe('FileSyncService', () => {
    it('distinguishes local paths and opaque service ID paths', () => {
        expect(parseSyncPath('C:\\workspace\\file.txt')).toMatchObject({ kind: 'local' });
        expect(parseSyncPath('\\\\server\\share\\file.txt')).toMatchObject({ kind: 'local' });
        expect(parseSyncPath('/workspace/file.txt')).toMatchObject({ kind: 'local' });
        expect(parseSyncPath(`${SERVICE_ID}:/workspace/file.txt`)).toEqual({
            kind: 'remote',
            serviceId: SERVICE_ID,
            path: '/workspace/file.txt',
        });
        expect(parseSyncPath('tenant/opaque+service:/workspace/file.txt')).toEqual({
            kind: 'remote',
            serviceId: 'tenant/opaque+service',
            path: '/workspace/file.txt',
        });
        expect(getRemoteServiceId('/workspace/file.txt', `${SERVICE_ID}:/workspace/file.txt`)).toBe(SERVICE_ID);
        expect(() => parseSyncPath('workspace/file.txt')).toThrowError(FileSyncError);
        expect(() => parseSyncPath(':/workspace/file.txt')).toThrowError('服务 ID 不能为空');
        expect(() => parseSyncPath(`${SERVICE_ID}:relative/file.txt`)).toThrowError(FileSyncError);
        expect(() => parseSyncPath(`${SERVICE_ID}:/workspace/../secret`)).toThrowError(FileSyncError);
    });

    it('uploads and downloads files through streaming SFTP with overwrite results', async () => {
        const directory = await createTemporaryDirectory();
        const source = path.join(directory, 'source.txt');
        const downloaded = path.join(directory, 'downloaded.txt');
        await fs.writeFile(source, 'upload content', 'utf8');
        const remote = new MemorySftp();
        const { service, configList, getContainerStatus, sftpProvider } = createService(remote);

        const upload = await service.syncFiles(source, `${SERVICE_ID}:/workspace/file.txt`);
        expect(remote.readFile('/workspace/file.txt')).toBe('upload content');
        expect(upload).toMatchObject({
            direction: 'upload',
            copied: 1,
            skipped: 0,
            deleted: 0,
            bytesTransferred: 14,
            complete: true,
        });

        const download = await service.syncFiles(`${SERVICE_ID}:/workspace/file.txt`, downloaded);
        expect(await fs.readFile(downloaded, 'utf8')).toBe('upload content');
        expect(download).toMatchObject({
            direction: 'download',
            copied: 1,
            skipped: 0,
            deleted: 0,
            bytesTransferred: 14,
            complete: true,
        });
        expect(remote.end).toHaveBeenCalledTimes(2);
        expect(configList).toHaveBeenCalledTimes(2);
        expect(getContainerStatus).toHaveBeenNthCalledWith(1, SERVICE_ID);
        expect(getContainerStatus).toHaveBeenNthCalledWith(2, SERVICE_ID);
        expect(getContainerStatus).not.toHaveBeenCalledWith(PHYSICAL_CONTAINER_ID);
        expect(sftpProvider).toHaveBeenCalledWith(expect.objectContaining({ serviceId: SERVICE_ID }));
    });

    it('recursively syncs directories, supports empty directories, and mirrors extras', async () => {
        const directory = await createTemporaryDirectory();
        const localRoot = path.join(directory, 'local');
        await fs.mkdir(path.join(localRoot, 'empty'), { recursive: true });
        await fs.writeFile(path.join(localRoot, 'file.txt'), 'new', 'utf8');
        const remote = new MemorySftp();
        remote.mkdirPath('/target');
        remote.setFile('/target/stale.txt', 'stale');
        const { service } = createService(remote);

        const result = await service.syncFiles(localRoot, `${SERVICE_ID}:/target`, 'overwrite', true);

        expect(remote.readFile('/target/file.txt')).toBe('new');
        expect(remote.has('/target/empty')).toBe(true);
        expect(remote.has('/target/stale.txt')).toBe(false);
        expect(result).toMatchObject({ direction: 'upload', deleted: 1, complete: true });
    });

    it('does not overwrite conflicts with skip and marks the result incomplete', async () => {
        const directory = await createTemporaryDirectory();
        const source = path.join(directory, 'source.txt');
        await fs.writeFile(source, 'new content', 'utf8');
        const remote = new MemorySftp();
        remote.mkdirPath('/workspace');
        remote.setFile('/workspace/file.txt', 'old content');
        const { service } = createService(remote);

        const result = await service.syncFiles(source, `${SERVICE_ID}:/workspace/file.txt`, 'skip');

        expect(remote.readFile('/workspace/file.txt')).toBe('old content');
        expect(result).toMatchObject({ skipped: 1, complete: false, copied: 0 });
    });

    it('rejects same-endpoint paths, stopped containers, and unsupported symlinks', async () => {
        const directory = await createTemporaryDirectory();
        const remote = new MemorySftp();
        const { service } = createService(remote, 'stopped');

        await expect(service.syncFiles(path.join(directory, 'one'), path.join(directory, 'two'))).rejects.toMatchObject({
            code: 'same_endpoint',
        });
        await expect(service.syncFiles(`${SERVICE_ID}:/one`, `${SERVICE_ID}:/two`)).rejects.toMatchObject({
            code: 'same_endpoint',
        });
        await expect(service.syncFiles(path.join(directory, 'one'), `${SERVICE_ID}:/one`)).rejects.toMatchObject({
            code: 'service_not_running',
            message: expect.stringContaining(SERVICE_ID),
        });

        const source = path.join(directory, 'link');
        const target = path.join(directory, 'target.txt');
        await fs.writeFile(target, 'target', 'utf8');
        try {
            await fs.symlink(target, source);
        } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
                return;
            }
            throw error;
        }
        await expect(createService(remote).service.syncFiles(source, `${SERVICE_ID}:/link`)).rejects.toMatchObject({
            code: 'unsupported_file_type',
        });
    });

    it('cleans temporary remote files when a stream fails', async () => {
        const directory = await createTemporaryDirectory();
        const source = path.join(directory, 'source.txt');
        await fs.writeFile(source, 'content', 'utf8');
        const remote = new FailingMemorySftp();
        const { service } = createService(remote);

        await expect(service.syncFiles(source, `${SERVICE_ID}:/workspace/file.txt`)).rejects.toMatchObject({
            code: 'transfer_failed',
        });
        expect(remote.paths().some(item => item.includes('.testagent-sync-'))).toBe(false);
        expect(remote.end).toHaveBeenCalledOnce();
    });
});

function createService(remote: MemorySftp, status = 'running') {
    const config = SSHConfig.parse(`Host service-alias\n\tServiceId ${SERVICE_ID}\n\tHostName 127.0.0.1\n\tPort 22\n`);
    const configList = vi.fn(() => [{ serviceId: SERVICE_ID, host: 'service-alias', hostName: '127.0.0.1', port: 22 }]);
    const getContainerStatus = vi.fn(async () => ({ status }));
    const sftpProvider = vi.fn(async () => ({ sftp: remote.asSftp() }));
    const service = new FileSyncService({
        config: {
            read: vi.fn(async () => ({ config, originalText: '' })),
            list: configList,
        },
        getContainerStatus,
        sftpProvider,
    });
    return { service, configList, getContainerStatus, sftpProvider };
}

async function createTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-file-sync-'));
    temporaryDirectories.push(directory);
    return directory;
}

interface MemoryNode {
    kind: 'file' | 'directory';
    content?: Buffer;
}

class MemorySftp {
    protected readonly nodes = new Map<string, MemoryNode>([['/', { kind: 'directory' }]]);
    public readonly end = vi.fn();

    public asSftp(): SFTPWrapper {
        return this as unknown as SFTPWrapper;
    }

    public has(remotePath: string): boolean {
        return this.nodes.has(remotePath);
    }

    public paths(): string[] {
        return [...this.nodes.keys()];
    }

    public readFile(remotePath: string): string {
        const node = this.nodes.get(remotePath);
        if (!node?.content) {
            throw new Error(`missing file ${remotePath}`);
        }
        return node.content.toString('utf8');
    }

    public mkdirPath(remotePath: string): void {
        this.nodes.set(remotePath, { kind: 'directory' });
    }

    public setFile(remotePath: string, content: string): void {
        this.nodes.set(remotePath, { kind: 'file', content: Buffer.from(content) });
    }

    public lstat(remotePath: string, callback: (error: Error | undefined, stats?: unknown) => void): void {
        const node = this.nodes.get(remotePath);
        if (!node) {
            callback(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
            return;
        }
        callback(undefined, {
            mode: node.kind === 'directory' ? 0o040755 : 0o100644,
            size: node.content?.length ?? 0,
        });
    }

    public readdir(remotePath: string, callback: (error: Error | undefined, entries?: unknown[]) => void): void {
        const directory = this.nodes.get(remotePath);
        if (!directory || directory.kind !== 'directory') {
            callback(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));
            return;
        }
        const prefix = remotePath === '/' ? '/' : `${remotePath}/`;
        const entries = [...this.nodes.keys()]
            .filter(item => item.startsWith(prefix) && item !== remotePath && !item.slice(prefix.length).includes('/'))
            .map(item => ({
                filename: path.posix.basename(item),
                longname: '',
                attrs: { mode: this.nodes.get(item)?.kind === 'directory' ? 0o040755 : 0o100644, size: this.nodes.get(item)?.content?.length ?? 0 },
            }));
        callback(undefined, entries);
    }

    public mkdir(remotePath: string, callback: (error?: Error) => void): void {
        if (this.nodes.has(remotePath)) {
            callback(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
            return;
        }
        this.nodes.set(remotePath, { kind: 'directory' });
        callback();
    }

    public unlink(remotePath: string, callback: (error?: Error) => void): void {
        if (!this.nodes.delete(remotePath)) {
            callback(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
            return;
        }
        callback();
    }

    public rmdir(remotePath: string, callback: (error?: Error) => void): void {
        const prefix = `${remotePath}/`;
        if ([...this.nodes.keys()].some(item => item.startsWith(prefix))) {
            callback(new Error('directory not empty'));
            return;
        }
        this.unlink(remotePath, callback);
    }

    public rename(oldPath: string, newPath: string, callback: (error?: Error) => void): void {
        const node = this.nodes.get(oldPath);
        if (!node) {
            callback(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
            return;
        }
        if (this.nodes.has(newPath)) {
            callback(Object.assign(new Error('already exists'), { code: 'EEXIST' }));
            return;
        }
        this.nodes.delete(oldPath);
        this.nodes.set(newPath, node);
        callback();
    }

    public createReadStream(remotePath: string): Readable {
        const node = this.nodes.get(remotePath);
        if (!node?.content) {
            throw new Error(`missing file ${remotePath}`);
        }
        return Readable.from([node.content]);
    }

    public createWriteStream(remotePath: string): Writable {
        const chunks: Buffer[] = [];
        return new Writable({
            write: (chunk, _encoding, callback) => {
                chunks.push(Buffer.from(chunk));
                callback();
            },
            final: callback => {
                this.nodes.set(remotePath, { kind: 'file', content: Buffer.concat(chunks) });
                callback();
            },
        });
    }
}

class FailingMemorySftp extends MemorySftp {
    override createWriteStream(remotePath: string): Writable {
        const stream = new Writable({
            write: (_chunk, _encoding, callback) => callback(new Error('stream failed')),
        });
        stream.on('close', () => this.nodes.delete(remotePath));
        return stream;
    }
}
