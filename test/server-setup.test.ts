import { beforeEach, describe, expect, it, vi } from 'vitest';
import type SSHConnection from '../src/ssh/sshConnection';
import type { Log } from '../src/common/logger';
import * as vscode from './mocks/vscode';

vi.mock('../src/serverConfig', () => ({
    DISTRO_COMMIT: 'testagent',
    getVSCodeServerConfig: vi.fn(async () => ({
        serverApplicationName: 'codium-server',
        serverDataFolderName: '.vscodium-server',
    })),
}));

import { installCodeServer } from '../src/serverSetup';

type CommandResult = {
    stdout: string;
    stderr: string;
};

function extractScript(command: string): string {
    const encodedScript = command.match(/^echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash -l$/)?.[1];
    return encodedScript
        ? Buffer.from(encodedScript, 'base64').toString('utf8')
        : command;
}

function resultForCommand(command: string): CommandResult {
    const script = extractScript(command);
    const scriptId = script.match(/([a-f0-9]{24}): start/)?.[1];
    if (!scriptId) {
        throw new Error('The generated server setup script did not contain a result marker');
    }

    return {
        stdout: [
            `${scriptId}: start`,
            'exitCode==0==',
            'listeningOn==1234==',
            'connectionToken==token==',
            'logFile==/tmp/server.log==',
            'osReleaseId==linux==',
            'arch==x64==',
            'platform==linux==',
            'tmpDir==/tmp==',
            `${scriptId}: end`,
        ].join('\n'),
        stderr: '',
    };
}

async function generateScript(platform: 'linux' | 'windows', disableClientValidation: boolean): Promise<string> {
    vscode.setConfigurationValue('testagnet.remote', 'disableClientValidation', disableClientValidation);
    const commands: string[] = [];
    const connection = {
        exec: vi.fn(async (command: string) => {
            commands.push(command);
            return command === 'uname -s' ? { stdout: '', stderr: '' } : resultForCommand(command);
        }),
        execPartial: vi.fn(async (command: string) => {
            commands.push(command);
            return resultForCommand(command);
        }),
    } as unknown as SSHConnection;
    const logger = {
        trace: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    } as unknown as Log;

    await installCodeServer(connection, [], [], platform, false, logger, process.cwd());

    const setupCommand = commands.find(command => command !== 'uname -s');
    if (!setupCommand) {
        throw new Error('The server setup command was not executed');
    }
    return extractScript(setupCommand);
}

describe('server setup client validation flag', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
    });

    for (const platform of ['linux', 'windows'] as const) {
        it(`adds the flag for ${platform} when enabled`, async () => {
            const script = await generateScript(platform, true);

            expect(script).toContain('--disable-client-validation');
            expect(script).toContain(platform === 'linux'
                ? 'SERVER_VALIDATION_FLAG="--disable-client-validation"'
                : '$SERVER_VALIDATION_FLAG="--disable-client-validation"');
        });

        it(`omits the flag for ${platform} when disabled`, async () => {
            const script = await generateScript(platform, false);

            expect(script).not.toContain('--disable-client-validation');
            expect(script).toContain(platform === 'linux'
                ? 'SERVER_VALIDATION_FLAG=""'
                : '$SERVER_VALIDATION_FLAG=""');
        });
    }
});
