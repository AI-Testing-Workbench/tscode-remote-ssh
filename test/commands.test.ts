import { beforeEach, describe, expect, it } from 'vitest';
import { openRemoteSSHWindow } from '../src/commands';
import * as vscode from './mocks/vscode';

describe('openRemoteSSHWindow', () => {
    beforeEach(() => {
        vscode.commands.executeCommand.mockClear();
        vscode.Uri.from.mockClear();
        vscode.resetConfiguration();
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
});
