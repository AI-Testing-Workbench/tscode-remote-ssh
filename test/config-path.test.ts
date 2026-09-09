import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ContainerConfig,
    DEFAULT_CONTAINER_CONFIG_SETTING,
    getConfiguredContainerConfigPath,
} from '../src/containerConfig';
import { expandPath } from '../src/common/files';
import { getSSHConfigPath } from '../src/ssh/sshConfig';
import * as vscode from './mocks/vscode';

const environmentVariable = 'TESTAGENT_CONFIG_PATH_ROOT';
let originalEnvironmentValue: string | undefined;
const temporaryDirectories: string[] = [];

describe('SSH config path setting', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
        originalEnvironmentValue = process.env[environmentVariable];
    });

    afterEach(async () => {
        if (originalEnvironmentValue === undefined) {
            delete process.env[environmentVariable];
        } else {
            process.env[environmentVariable] = originalEnvironmentValue;
        }
        while (temporaryDirectories.length) {
            const directory = temporaryDirectories.pop();
            if (directory) {
                await fs.rm(directory, { recursive: true, force: true });
            }
        }
    });

    it('uses the dedicated default when configFile is not overridden', () => {
        const defaultPath = path.resolve(os.homedir(), '.local', 'share', 'testagent', 'config');
        expect(getConfiguredContainerConfigPath()).toBe(defaultPath);
        expect(DEFAULT_CONTAINER_CONFIG_SETTING).toBe('~/.local/share/testagent/config');
    });

    it('uses a config file inside an existing configFile directory', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-directory-'));
        temporaryDirectories.push(directory);
        vscode.setConfigurationValue('tscode.remote', 'configFile', directory);

        const expectedPath = path.join(directory, 'config');
        expect(getConfiguredContainerConfigPath()).toBe(expectedPath);
        const store = new ContainerConfig();
        await expect(store.read()).resolves.toMatchObject({ originalText: '' });
        expect(store.filePath).toBe(expectedPath);
    });

    it('expands tilde, Unix variables, braced variables, and Windows variables', () => {
        process.env[environmentVariable] = path.join(os.tmpdir(), 'testagent-config-root');

        expect(expandPath('~/config', path.join('C:', 'Users', 'alice'))).toBe('C:\\Users\\alice/config');
        expect(expandPath(`$${environmentVariable}/config`)).toBe(`${process.env[environmentVariable]}/config`);
        expect(expandPath(`\${${environmentVariable}}/config`)).toBe(`${process.env[environmentVariable]}/config`);
        expect(expandPath(`%${environmentVariable}%\\config`)).toBe(`${process.env[environmentVariable]}\\config`);
    });

    it('resolves an expanded custom configFile path to an absolute path', () => {
        process.env[environmentVariable] = path.join(os.tmpdir(), 'testagent-config-root');
        vscode.setConfigurationValue('tscode.remote', 'configFile', `$${environmentVariable}/ssh/config`);

        const expectedPath = path.resolve(process.env[environmentVariable] ?? '', 'ssh', 'config');
        expect(getConfiguredContainerConfigPath()).toBe(expectedPath);
        expect(getSSHConfigPath()).toBe(expectedPath);
        expect(new ContainerConfig().filePath).toBe(expectedPath);
    });
});
