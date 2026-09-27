import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildTestagentConfigSyncEntries,
    copyTestagentConfigToRemote,
    localTestagentConfigRoot,
    localTestagentDataRoot,
    type TestagentConfigConnection,
} from '../src/testagentConfigSync';
import { Log } from './mocks/logger';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-sync-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('testagent config sync', () => {
    it('honors XDG overrides and falls back to the home directory', () => {
        expect(localTestagentConfigRoot({ XDG_CONFIG_HOME: '/xdg/config' } as NodeJS.ProcessEnv, '/home/user')).toBe(path.join('/xdg/config', 'testagent'));
        expect(localTestagentConfigRoot({} as NodeJS.ProcessEnv, '/home/user')).toBe(path.join('/home/user', '.config', 'testagent'));
        expect(localTestagentDataRoot({ XDG_DATA_HOME: '/xdg/data' } as NodeJS.ProcessEnv, '/home/user')).toBe(path.join('/xdg/data', 'testagent'));
        expect(localTestagentDataRoot({} as NodeJS.ProcessEnv, '/home/user')).toBe(path.join('/home/user', '.local', 'share', 'testagent'));
    });

    it('builds the known local to remote file map', () => {
        expect(buildTestagentConfigSyncEntries('/local/config', '/local/data', '/remote/config', '/remote/data')).toEqual([
            { localPath: path.join('/local/config', 'testagent.jsonc'), remotePath: '/remote/config/testagent.jsonc' },
            { localPath: path.join('/local/data', 'auth.json'), remotePath: '/remote/data/auth.json' },
            { localPath: path.join('/local/data', 'env-vars.json'), remotePath: '/remote/data/env-vars.json' },
        ]);
    });

    it('copies existing files with 0600 and skips missing ones', async () => {
        const root = await makeTemporaryDirectory();
        const localConfigRoot = path.join(root, 'config');
        const localDataRoot = path.join(root, 'data');
        await fs.mkdir(localConfigRoot, { recursive: true });
        await fs.mkdir(localDataRoot, { recursive: true });

        const jsonc = '{"model":"deepseek-flash"}';
        const auth = '{"token":"secret"}';
        const envVars = '{"FOO":"bar"}';
        await fs.writeFile(path.join(localConfigRoot, 'testagent.jsonc'), jsonc);
        await fs.writeFile(path.join(localDataRoot, 'auth.json'), auth);
        await fs.writeFile(path.join(localDataRoot, 'env-vars.json'), envVars);
        // Present locally but must be excluded: holds the sandbox's platform identity.
        await fs.writeFile(path.join(localDataRoot, 'external-user.json'), '{"token":"local-user"}');

        const commands: string[] = [];
        const connection: TestagentConfigConnection = {
            exec: async (command: string) => {
                commands.push(command);
                if (command.includes('XDG_CONFIG_HOME')) {
                    return { stdout: '/remote/.config/testagent\n/remote/.local/share/testagent\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
        };

        await copyTestagentConfigToRemote(connection, new Log('test'), { localConfigRoot, localDataRoot });

        const decoded = new Map<string, string>();
        for (const command of commands) {
            const match = /printf %s '([^']*)' \| base64 -d > '([^']*)'/.exec(command);
            if (match) {
                decoded.set(match[2], Buffer.from(match[1], 'base64').toString('utf8'));
                expect(command).toContain('chmod 700');
                expect(command).toContain('chmod 600');
            }
        }

        expect([...decoded.keys()].sort()).toEqual([
            '/remote/.config/testagent/testagent.jsonc',
            '/remote/.local/share/testagent/auth.json',
            '/remote/.local/share/testagent/env-vars.json',
        ]);
        expect(decoded.get('/remote/.config/testagent/testagent.jsonc')).toBe(jsonc);
        expect(decoded.get('/remote/.local/share/testagent/auth.json')).toBe(auth);
        expect(decoded.get('/remote/.local/share/testagent/env-vars.json')).toBe(envVars);
    });

    it('honors the file whitelist', async () => {
        const root = await makeTemporaryDirectory();
        const localConfigRoot = path.join(root, 'config');
        const localDataRoot = path.join(root, 'data');
        await fs.mkdir(localConfigRoot, { recursive: true });
        await fs.mkdir(localDataRoot, { recursive: true });
        await fs.writeFile(path.join(localConfigRoot, 'testagent.jsonc'), '{}');
        await fs.writeFile(path.join(localDataRoot, 'auth.json'), '{"token":"secret"}');
        await fs.writeFile(path.join(localDataRoot, 'env-vars.json'), '{}');

        const written: string[] = [];
        const connection: TestagentConfigConnection = {
            exec: async (command: string) => {
                if (command.includes('XDG_CONFIG_HOME')) {
                    return { stdout: '/remote/.config/testagent\n/remote/.local/share/testagent\n', stderr: '' };
                }
                const match = /base64 -d > '([^']*)'/.exec(command);
                if (match) {
                    written.push(match[1]);
                }
                return { stdout: '', stderr: '' };
            },
        };

        await copyTestagentConfigToRemote(connection, new Log('test'), { localConfigRoot, localDataRoot, fileNames: ['auth.json'] });

        expect(written).toEqual(['/remote/.local/share/testagent/auth.json']);
    });

    it('never throws when the remote roots cannot be resolved', async () => {
        const connection: TestagentConfigConnection = {
            exec: async () => ({ stdout: '', stderr: '' }),
        };

        await expect(copyTestagentConfigToRemote(connection, new Log('test'))).resolves.toBeUndefined();
    });
});
