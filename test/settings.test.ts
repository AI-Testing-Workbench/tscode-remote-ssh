import { beforeEach, describe, expect, it } from 'vitest';
import { getRemoteSettings } from '../src/settings';
import * as vscode from './mocks/vscode';

describe('remote settings', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
    });

    it('returns the configured values without mixing setting types', () => {
        vscode.setConfigurationValue('tscode.remote', 'backendApiUrl', ' https://api.example.test/ ');
        vscode.setConfigurationValue('tscode.remote', 'userName', ' cloud-user ');
        vscode.setConfigurationValue('tscode.remote', 'skipKnownHostsCheck', false);
        vscode.setConfigurationValue('tscode.remote', 'historyLimit', 12);
        vscode.setConfigurationValue('tscode.remote', 'statusSyncInterval', 2.5);
        vscode.setConfigurationValue('tscode.remote', 'debug', true);
        vscode.setConfigurationValue('tscode.remote', 'disableClientValidation', false);

        expect(getRemoteSettings()).toEqual({
            backendApiUrl: 'https://api.example.test/',
            userName: 'cloud-user',
            skipKnownHostsCheck: false,
            historyLimit: 12,
            statusSyncInterval: 2.5,
            debug: true,
            disableClientValidation: false,
        });
    });

    it('uses safe defaults for invalid configured values', () => {
        vscode.setConfigurationValue('tscode.remote', 'backendApiUrl', false);
        vscode.setConfigurationValue('tscode.remote', 'userName', 42);
        vscode.setConfigurationValue('tscode.remote', 'skipKnownHostsCheck', 'false');
        vscode.setConfigurationValue('tscode.remote', 'historyLimit', 1.5);
        vscode.setConfigurationValue('tscode.remote', 'statusSyncInterval', 0);
        vscode.setConfigurationValue('tscode.remote', 'debug', 'true');
        vscode.setConfigurationValue('tscode.remote', 'disableClientValidation', 'false');

        expect(getRemoteSettings()).toEqual({
            backendApiUrl: '',
            userName: 'root',
            skipKnownHostsCheck: true,
            historyLimit: 5,
            statusSyncInterval: 5,
            debug: false,
            disableClientValidation: true,
        });
    });

    it('keeps an explicitly blank userName for current SSH fallback handling', () => {
        vscode.setConfigurationValue('tscode.remote', 'userName', '   ');

        expect(getRemoteSettings().userName).toBe('');
    });
});
