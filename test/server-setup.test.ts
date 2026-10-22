import { beforeEach, describe, expect, it, vi } from 'vitest';
import type SSHConnection from '../src/ssh/sshConnection';
import type { Log } from '../src/common/logger';
import * as vscode from './mocks/vscode';

vi.mock('../src/serverConfig', () => ({
    DISTRO_COMMIT: 'tscode',
    getVSCodeServerConfig: vi.fn(async () => ({
        serverApplicationName: 'codium-server',
        serverDataFolderName: '.vscodium-server',
        clientCommit: 'local-commit-123',
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

async function generateScript(platform: 'linux' | 'windows', disableClientValidation: boolean, forceClientCommit = true): Promise<string> {
    vscode.setConfigurationValue('tscode.remote', 'disableClientValidation', disableClientValidation);
    vscode.setConfigurationValue('tscode.remote', 'forceClientCommit', forceClientCommit);
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

    it('normalizes line endings in the generated Bash setup script', async () => {
        const script = await generateScript('linux', false);

        expect(script).not.toContain('\r');
    });

    for (const platform of ['linux', 'windows'] as const) {
        it(`passes the local commit and force setting to the ${platform} script`, async () => {
            const script = await generateScript(platform, false, true);

            expect(script).toContain(platform === 'linux'
                ? 'CLIENT_COMMIT="local-commit-123"'
                : '$CLIENT_COMMIT="local-commit-123"');
            expect(script).toContain(platform === 'linux'
                ? 'FORCE_CLIENT_COMMIT="true"'
                : '$FORCE_CLIENT_COMMIT="true"');
            expect(script).toContain(platform === 'linux' ? 'get_installed_commit()' : 'function Get-InstalledCommit()');
            expect(script).toContain('product.json.backup');
            expect(script).toContain(platform === 'linux'
                ? 'if [[ -z "$SERVER_RUNNING_PROCESS" && "$FORCE_CLIENT_COMMIT" == "true" ]]'
                : 'if($FORCE_CLIENT_COMMIT -eq "true" -and $SERVER_RUNNING_PROCESS.Count -eq 0)');
            expect(script).toContain(platform === 'linux'
                ? 'rm -f "$SERVER_PRODUCT_JSON_BACKUP"'
                : 'Remove-Item -LiteralPath $SERVER_PRODUCT_JSON_BACKUP -Force');
            expect(script).toContain(platform === 'linux'
                ? 'cp "$SERVER_PRODUCT_JSON" "$SERVER_PRODUCT_JSON_BACKUP"'
                : 'Copy-Item -LiteralPath $SERVER_PRODUCT_JSON -Destination $SERVER_PRODUCT_JSON_BACKUP');
        });

        it(`passes a disabled force setting to the ${platform} script`, async () => {
            const script = await generateScript(platform, false, false);

            expect(script).toContain(platform === 'linux'
                ? 'FORCE_CLIENT_COMMIT="false"'
                : '$FORCE_CLIENT_COMMIT="false"');
        });
    }
});
