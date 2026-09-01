import * as os from 'node:os';
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

describe('SSH config path setting', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
        originalEnvironmentValue = process.env[environmentVariable];
    });

    afterEach(() => {
        if (originalEnvironmentValue === undefined) {
            delete process.env[environmentVariable];
        } else {
            process.env[environmentVariable] = originalEnvironmentValue;
        }
    });

    it('uses the dedicated default when configFile is not overridden', () => {
        expect(getConfiguredContainerConfigPath()).toBe(
            path.resolve(os.homedir(), '.local', 'share', 'testagent'),
        );
        expect(DEFAULT_CONTAINER_CONFIG_SETTING).toBe('~/.local/share/testagent');
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
        vscode.setConfigurationValue('testagnet.remote', 'configFile', `$${environmentVariable}/ssh/config`);

        const expectedPath = path.resolve(process.env[environmentVariable] ?? '', 'ssh', 'config');
        expect(getConfiguredContainerConfigPath()).toBe(expectedPath);
        expect(getSSHConfigPath()).toBe(expectedPath);
        expect(new ContainerConfig().filePath).toBe(expectedPath);
    });
});
