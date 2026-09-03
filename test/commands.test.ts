import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRemoteSSHWindow, promptOpenRemoteSSHWindow } from '../src/commands';
import { ContainerConfig } from '../src/containerConfig';
import * as vscode from './mocks/vscode';

const temporaryDirectories: string[] = [];

describe('openRemoteSSHWindow', () => {
    beforeEach(() => {
        vscode.commands.executeCommand.mockClear();
        vscode.Uri.from.mockClear();
        vscode.resetConfiguration();
        vscode.window.createQuickPick.mockReset();
    });

    afterEach(async () => {
        while (temporaryDirectories.length) {
            const directory = temporaryDirectories.pop();
            if (directory) {
                await fs.rm(directory, { recursive: true, force: true });
            }
        }
    });

    it('opens an empty remote window when no default path is configured', () => {
        openRemoteSSHWindow('dev', false);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.newWindow',
            { remoteAuthority: 'ssh-remote+dev', reuseWindow: false }
        );
        expect(vscode.Uri.from).not.toHaveBeenCalled();
    });

    it('opens the configured remote folder or workspace', () => {
        const remotePath = '/workspaces/project.code-workspace';
        vscode.setConfigurationValue('testagnet.remote', 'defaultPath', remotePath);

        openRemoteSSHWindow('dev', true);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'vscode.openFolder',
            { scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: remotePath },
            { forceNewWindow: false }
        );
        expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
            'vscode.newWindow',
            expect.anything()
        );
    });

    it('lists only TestAgent Cloud services from the dedicated config', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testagent-command-'));
        temporaryDirectories.push(directory);
        const configPath = path.join(directory, 'config');
        await fs.writeFile(configPath, [
            'Host "TestAgent Cloud Service"',
            '\tHostName 10.0.0.1',
            '\tContainerId service-1',
            '',
            'Host "Expired TestAgent Cloud Service"',
            '\tHostName 10.0.0.2',
            '\tContainerId expired-service',
            '\tExpiresAt 2026-09-01T00:00:00.000Z',
            '',
            'Host ordinary-ssh-host',
            '\tHostName ordinary.example.test',
            '',
        ].join('\n'), 'utf8');
        vscode.setConfigurationValue('testagnet.remote', 'configFile', configPath);
        const configured = new ContainerConfig(configPath);
        const document = await configured.read();
        expect(configured.list(document.config)).toEqual([
            {
                containerId: 'service-1',
                host: 'TestAgent Cloud Service',
                hostName: '10.0.0.1',
            },
            {
                containerId: 'expired-service',
                host: 'Expired TestAgent Cloud Service',
                hostName: '10.0.0.2',
                expiresAt: '2026-09-01T00:00:00.000Z',
            },
        ]);
        expect(new ContainerConfig().filePath).toBe(configPath);

        let hideListener: (() => void) | undefined;
        const quickPick = {
            title: '',
            placeholder: '',
            items: [],
            value: '',
            selectedItems: [],
            onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
            onDidAccept: vi.fn(() => ({ dispose: vi.fn() })),
            onDidHide: vi.fn((listener: () => void) => {
                hideListener = listener;
                return { dispose: vi.fn() };
            }),
            show: vi.fn(),
            hide: vi.fn(),
            dispose: vi.fn(),
        };
        vscode.window.createQuickPick.mockReturnValue(quickPick as never);

        const pending = promptOpenRemoteSSHWindow(false);
        await vi.waitFor(() => expect(vscode.window.createQuickPick).toHaveBeenCalledOnce());

        expect(quickPick.items).toEqual([{ label: 'TestAgent Cloud Service' }]);
        hideListener?.();
        await pending;
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
});
