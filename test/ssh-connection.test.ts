import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sftp = {
    end: vi.fn(),
};
const clients: MockClient[] = [];

vi.mock('ssh2', () => ({
    Client: class MockClient extends EventEmitter {
        public constructor() {
            super();
            clients.push(this);
        }

        public connect(): this {
            queueMicrotask(() => this.emit('ready'));
            return this;
        }

        public sftp(callback: (error: Error | undefined, value: unknown) => void): void {
            callback(undefined, sftp);
        }

        public end(): void {
            this.emit('close');
        }
    },
}));

import SSHConnection from '../src/ssh/sshConnection';

interface MockClient extends EventEmitter {
    connect(): MockClient;
    sftp(callback: (error: Error | undefined, value: unknown) => void): void;
    end(): void;
}

describe('SSHConnection SFTP', () => {
    beforeEach(() => {
        clients.length = 0;
        sftp.end.mockReset();
    });

    it('opens SFTP through the existing authenticated SSH connection', async () => {
        const connection = new SSHConnection({ host: 'container', username: 'root' });

        await expect(connection.sftp()).resolves.toBe(sftp);
        expect(clients).toHaveLength(1);
    });

    it('propagates an SFTP subsystem error without opening a shell command', async () => {
        const error = new Error('sftp unavailable');
        const client = new SSHConnection({ host: 'container', username: 'root' });
        const opened = clients.length;
        const connectionClient = await client.connect();
        const rawClient = clients[opened];
        rawClient.sftp = callback => callback(error, undefined);

        await expect(connectionClient.sftp()).rejects.toBe(error);
        expect(rawClient).toBe(clients[opened]);
    });
});
