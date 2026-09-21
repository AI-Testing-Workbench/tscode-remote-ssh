import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    ContainerConfig,
    DEFAULT_CONTAINER_CONFIG_PATH,
    getConfiguredContainerConfigPath,
    getLegacyContainerConfigPath,
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

    it('uses the hardcoded sandbox SSH config path', () => {
        const defaultPath = path.resolve(os.homedir(), '.local', 'share', 'testagent', 'sandbox.config');
        expect(getConfiguredContainerConfigPath()).toBe(defaultPath);
        expect(DEFAULT_CONTAINER_CONFIG_PATH).toBe('~/.local/share/testagent/sandbox.config');
    });

    it('ignores the removed configFile setting', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-config-directory-'));
        temporaryDirectories.push(directory);
        vscode.setConfigurationValue('tscode.remote', 'configFile', directory);

        expect(getConfiguredContainerConfigPath()).toBe(path.resolve(os.homedir(), '.local', 'share', 'testagent', 'sandbox.config'));
    });

    it('reads the legacy configFile setting only for migration', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-legacy-config-'));
        temporaryDirectories.push(directory);
        const legacyPath = path.join(directory, 'config');
        vscode.setConfigurationValue('tscode.remote', 'configFile', legacyPath);

        expect(getLegacyContainerConfigPath()).toBe(legacyPath);
        expect(getConfiguredContainerConfigPath()).not.toBe(legacyPath);
    });

    it('expands tilde, Unix variables, braced variables, and Windows variables', () => {
        process.env[environmentVariable] = path.join(os.tmpdir(), 'testagent-config-root');

        expect(expandPath('~/config', path.join('C:', 'Users', 'alice'))).toBe('C:\\Users\\alice/config');
        expect(expandPath(`$${environmentVariable}/config`)).toBe(`${process.env[environmentVariable]}/config`);
        expect(expandPath(`\${${environmentVariable}}/config`)).toBe(`${process.env[environmentVariable]}/config`);
        expect(expandPath(`%${environmentVariable}%\\config`)).toBe(`${process.env[environmentVariable]}\\config`);
    });

    it('keeps path expansion available for other file settings', () => {
        process.env[environmentVariable] = path.join(os.tmpdir(), 'testagent-config-root');

        const expectedPath = `${process.env[environmentVariable]}/ssh/config`;
        expect(expandPath(`$${environmentVariable}/ssh/config`)).toBe(expectedPath);
        expect(getSSHConfigPath()).toBe(getConfiguredContainerConfigPath());
        expect(new ContainerConfig().filePath).toBe(getConfiguredContainerConfigPath());
    });
});
