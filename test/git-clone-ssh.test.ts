import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientChannel } from 'ssh2';
import type SSHConnectionType from '../src/ssh/sshConnection';
import { getRemoteAuthority, RemoteSSHResolver, SSHConfiguration, SSHConnection } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import type { Log as SourceLog } from '../src/common/logger';
import { GIT_CLONE_COMMAND } from '../src/ssh/gitCloneCommand';
import SSHDestination from '../src/ssh/sshDestination';
import type { ContainerConfigEntry } from '../src/containerConfig';

describe('码云初始化脚本执行', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vscode.resetConfiguration();
    });

    it('使用实时服务地址并将脚本输出写入容器日志', async () => {
        const connectionConfigs: SSHConnectionType['config'][] = [];
        const channel = createSSHChannel();
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            connectionConfigs.push(this.config);
            return Promise.resolve(this);
        });
        const execChannel = vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async command => {
            expect(command).toBe(GIT_CLONE_COMMAND);
            setTimeout(() => {
                channel.emit('exit', 0);
                channel.emit('close');
            }, 0);
            return channel as unknown as ClientChannel;
        });
        const close = vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        const getHostConfiguration = mockSSHConfig();

        await createResolver().executeGitCloneScript('service-1', 'repo-host', '10.20.30.40:2222');

        expect(connect).toHaveBeenCalledOnce();
        expect(connectionConfigs[0]).toMatchObject({ host: '10.20.30.40', port: 2222, username: 'root' });
        expect(getHostConfiguration).toHaveBeenCalledWith('repo-host');
        expect(execChannel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it('从连接通道关闭事件读取成功退出状态', async () => {
        const channel = createSSHChannel();
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => {
            setTimeout(() => channel.emit('close', 0), 0);
            return channel as unknown as ClientChannel;
        });
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().executeGitCloneScript('service-1', 'repo-host', '10.20.30.40:2222'))
            .resolves.toBeUndefined();
    });

    it('遇到暂时性连接错误时重试，但身份验证失败时不重试', async () => {
        const channel = createSSHChannel();
        let attempts = 0;
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            attempts += 1;
            if (attempts === 1) {
                return Promise.reject(Object.assign(new Error('连接被拒绝'), { code: 'ECONNREFUSED' }));
            }
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => {
            setTimeout(() => {
                channel.emit('exit', 0);
                channel.emit('close');
            }, 0);
            return channel as unknown as ClientChannel;
        });
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await createResolver().executeGitCloneScript('service-1', 'repo-host', '10.20.30.40:2222');

        expect(connect).toHaveBeenCalledTimes(2);
    });

    it('身份验证失败时不重试', async () => {
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockRejectedValue(
            Object.assign(new Error('身份验证失败'), { level: 'client-authentication' }),
        );
        const execChannel = vi.spyOn(SSHConnection.prototype, 'execChannel');
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().executeGitCloneScript(
            'service-1',
            'repo-host',
            '10.20.30.40:2222',
        )).rejects.toThrow('连接服务失败，请检查网络、连接配置和身份验证信息');

        expect(connect).toHaveBeenCalledOnce();
        expect(execChannel).not.toHaveBeenCalled();
    });

    it('码云初始化脚本返回非零退出状态时失败', async () => {
        const channel = createSSHChannel();
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => {
            setTimeout(() => channel.emit('close', 17), 0);
            return channel as unknown as ClientChannel;
        });
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().executeGitCloneScript('service-1', 'repo-host', '10.20.30.40:2222'))
            .rejects.toThrow('码云初始化脚本执行失败，退出状态：17');
    });

    it('取消初始化时关闭命令通道', async () => {
        const channel = createSSHChannel();
        const controller = new AbortController();
        const execChannel = vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => channel as unknown as ClientChannel);
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        const close = vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();
        const execution = createResolver().executeGitCloneScript('service-1', 'repo-host', '10.20.30.40:2222', controller.signal);

        await vi.waitFor(() => expect(execChannel).toHaveBeenCalledOnce());
        controller.abort();
        await expect(execution).rejects.toThrow('码云初始化脚本执行已取消');
        expect(channel.close).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('按需建立 SFTP 会话', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vscode.resetConfiguration();
    });

    it('按配置别名和当前 endpoint 建立独立 SSH transport，并在 dispose 时关闭全部资源', async () => {
        const sftp = { end: vi.fn() } as unknown as import('ssh2').SFTPWrapper;
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        const openSftp = vi.spyOn(SSHConnection.prototype, 'sftp').mockResolvedValue(sftp);
        const close = vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        const getHostConfiguration = mockSSHConfig({ User: 'configured-user' });
        const resolver = createResolver();
        const entry: ContainerConfigEntry = {
            serviceId: 'service-1',
            host: 'callback-alias',
            hostName: '10.20.30.40',
            port: 2222,
        };

        const session = await resolver.openSftpSession(entry);

        expect(connect).toHaveBeenCalledOnce();
        expect(connect.mock.contexts[0]).toMatchObject({
            config: {
                host: '10.20.30.40',
                port: 2222,
                username: 'configured-user',
            },
        });
        expect(getHostConfiguration).toHaveBeenCalledWith('callback-alias');
        expect(openSftp).toHaveBeenCalledOnce();
        expect(session.sftp).toBe(sftp);

        await session.dispose();
        await session.dispose();

        expect(sftp.end).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it('在 SFTP subsystem 建立失败时关闭独立 SSH transport', async () => {
        const error = new Error('SFTP subsystem unavailable');
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'sftp').mockRejectedValue(error);
        const close = vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().openSftpSession({
            serviceId: 'service-1',
            host: 'callback-alias',
            hostName: '10.20.30.40',
            port: 2222,
        })).rejects.toBe(error);

        expect(connect).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('SSH service identity', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vscode.resetConfiguration();
    });

    it('uses ServiceId for service endpoint validation while keeping Host as the authority alias', async () => {
        const getHostConfiguration = mockSSHConfig({
            ServiceId: 'service-1',
            HostName: 'not-an-ip',
            Port: '2222',
        });
        const resolver = createResolver();
        const authority = getRemoteAuthority(new SSHDestination('readable-host-alias').toEncodedString());

        await expect(resolver.resolve(authority, new vscode.RemoteAuthorityResolverContext() as never))
            .rejects.toThrow('服务 "service-1" 的 endpoint 无效');

        expect(getHostConfiguration).toHaveBeenCalledWith('readable-host-alias');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('服务 "service-1" 的 endpoint 无效'),
            { modal: true },
        );
    });

    it('deduplicates debug confirmation by service ID rather than SSH alias', async () => {
        vscode.setConfigurationValue('tscode.remote', 'debug', true);
        vscode.window.showWarningMessage.mockResolvedValue('继续' as never);
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => {
            const channel = createSSHChannel();
            setTimeout(() => {
                channel.emit('exit', 0);
                channel.emit('close');
            }, 0);
            return channel as unknown as ClientChannel;
        });
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        const getHostConfiguration = mockSSHConfig();
        const resolver = createResolver();

        await resolver.executeGitCloneScript('service-1', 'host-alias-a', '10.20.30.40:2222');
        await resolver.executeGitCloneScript('service-1', 'host-alias-b', '10.20.30.40:2222');
        await resolver.executeGitCloneScript('service-2', 'host-alias-a', '10.20.30.40:2222');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
        expect(getHostConfiguration).toHaveBeenNthCalledWith(1, 'host-alias-a');
        expect(getHostConfiguration).toHaveBeenNthCalledWith(2, 'host-alias-b');
        expect(getHostConfiguration).toHaveBeenNthCalledWith(3, 'host-alias-a');
    });
});

function createResolver(): InstanceType<typeof RemoteSSHResolver> {
    return new RemoteSSHResolver(
        new vscode.ExtensionContext() as unknown as import('vscode').ExtensionContext,
        new Log('码云初始化') as unknown as SourceLog,
    );
}

function mockSSHConfig(overrides: Record<string, string> = {}): ReturnType<typeof vi.fn> {
    const getHostConfiguration = vi.fn(() => ({
        User: 'ssh-config-user',
        IdentitiesOnly: 'yes',
        IdentityFile: [],
        ...overrides,
    }));
    const sshConfig = {
        getHostConfiguration,
    };
    vi.spyOn(SSHConfiguration, 'loadFromFS').mockResolvedValue(
        sshConfig as unknown as Awaited<ReturnType<typeof SSHConfiguration.loadFromFS>>,
    );
    return getHostConfiguration;
}

function createSSHChannel(): EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn> } {
    const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn> };
    channel.stderr = new EventEmitter();
    channel.close = vi.fn();
    return channel;
}
