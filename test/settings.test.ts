import { beforeEach, describe, expect, it } from 'vitest';
import { getRemoteSettings } from '../src/settings';
import * as vscode from './mocks/vscode';

describe('remote settings', () => {
    beforeEach(() => {
        vscode.resetConfiguration();
    });

    it('returns the configured values without mixing setting types', () => {
        vscode.setConfigurationValue('testagnet.remote', 'backendApiUrl', ' https://api.example.test/ ');
        vscode.setConfigurationValue('testagnet.remote', 'skipKnownHostsCheck', false);
        vscode.setConfigurationValue('testagnet.remote', 'historyLimit', 12);
        vscode.setConfigurationValue('testagnet.remote', 'statusSyncInterval', 2.5);

        expect(getRemoteSettings()).toEqual({
            backendApiUrl: 'https://api.example.test/',
            skipKnownHostsCheck: false,
            historyLimit: 12,
            statusSyncInterval: 2.5,
        });
    });

    it('uses safe defaults for invalid configured values', () => {
        vscode.setConfigurationValue('testagnet.remote', 'backendApiUrl', false);
        vscode.setConfigurationValue('testagnet.remote', 'skipKnownHostsCheck', 'false');
        vscode.setConfigurationValue('testagnet.remote', 'historyLimit', 1.5);
        vscode.setConfigurationValue('testagnet.remote', 'statusSyncInterval', 0);

        expect(getRemoteSettings()).toEqual({
            backendApiUrl: '',
            skipKnownHostsCheck: true,
            historyLimit: 5,
            statusSyncInterval: 5,
        });
    });
});
