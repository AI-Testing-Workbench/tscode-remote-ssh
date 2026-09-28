import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientChannel } from 'ssh2';
import type SSHConnectionType from '../src/ssh/sshConnection';
import { RemoteSSHResolver, SSHConfiguration, SSHConnection } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import type { Log as SourceLog } from '../src/common/logger';
import { GIT_CLONE_COMMAND } from '../src/ssh/gitCloneCommand';

describe('Remote Git clone execution', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vscode.resetConfiguration();
    });

    it('uses the live endpoint and redirects the clone command to container logs', async () => {
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
        mockSSHConfig();

        await createResolver().executeGitCloneScript('container-1', 'repo-host', '10.20.30.40:2222');

        expect(connect).toHaveBeenCalledOnce();
        expect(connectionConfigs[0]).toMatchObject({ host: '10.20.30.40', port: 2222, username: 'root' });
        expect(execChannel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });

    it('retries a transient SSH-not-ready error but does not retry authentication errors', async () => {
        const channel = createSSHChannel();
        let attempts = 0;
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            attempts += 1;
            if (attempts === 1) {
                return Promise.reject(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
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

        await createResolver().executeGitCloneScript('container-1', 'repo-host', '10.20.30.40:2222');

        expect(connect).toHaveBeenCalledTimes(2);
    });

    it('fails on an SSH authentication error without retrying', async () => {
        const connect = vi.spyOn(SSHConnection.prototype, 'connect').mockRejectedValue(
            Object.assign(new Error('authentication failed'), { level: 'client-authentication' }),
        );
        const execChannel = vi.spyOn(SSHConnection.prototype, 'execChannel');
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().executeGitCloneScript(
            'container-1',
            'repo-host',
            '10.20.30.40:2222',
        )).rejects.toThrow('authentication failed');

        expect(connect).toHaveBeenCalledOnce();
        expect(execChannel).not.toHaveBeenCalled();
    });

    it('rejects a non-zero clone script exit', async () => {
        const channel = createSSHChannel();
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => {
            setTimeout(() => {
                channel.emit('exit', 17);
                channel.emit('close');
            }, 0);
            return channel as unknown as ClientChannel;
        });
        vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();

        await expect(createResolver().executeGitCloneScript('container-1', 'repo-host', '10.20.30.40:2222'))
            .rejects.toThrow('exited with status 17');
    });

    it('closes the SSH command channel when initialization is cancelled', async () => {
        const channel = createSSHChannel();
        const controller = new AbortController();
        const execChannel = vi.spyOn(SSHConnection.prototype, 'execChannel').mockImplementation(async () => channel as unknown as ClientChannel);
        vi.spyOn(SSHConnection.prototype, 'connect').mockImplementation(function (this: SSHConnectionType) {
            return Promise.resolve(this);
        });
        const close = vi.spyOn(SSHConnection.prototype, 'close').mockResolvedValue(undefined);
        mockSSHConfig();
        const execution = createResolver().executeGitCloneScript('container-1', 'repo-host', '10.20.30.40:2222', controller.signal);

        await vi.waitFor(() => expect(execChannel).toHaveBeenCalledOnce());
        controller.abort();
        await expect(execution).rejects.toThrow('cancelled');
        expect(channel.close).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
});

function createResolver(): InstanceType<typeof RemoteSSHResolver> {
    return new RemoteSSHResolver(
        new vscode.ExtensionContext() as unknown as import('vscode').ExtensionContext,
        new Log('Remote - SSH') as unknown as SourceLog,
    );
}

function mockSSHConfig(): void {
    const sshConfig = {
        getHostConfiguration: vi.fn(() => ({
            User: 'ssh-config-user',
            IdentitiesOnly: 'yes',
            IdentityFile: [],
        })),
    };
    vi.spyOn(SSHConfiguration, 'loadFromFS').mockResolvedValue(
        sshConfig as unknown as Awaited<ReturnType<typeof SSHConfiguration.loadFromFS>>,
    );
}

function createSSHChannel(): EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn> } {
    const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn> };
    channel.stderr = new EventEmitter();
    channel.close = vi.fn();
    return channel;
}
