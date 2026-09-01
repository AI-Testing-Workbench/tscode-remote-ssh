import * as vscode from 'vscode';

export const REMOTE_CONFIGURATION_SECTION = 'testagnet.remote';

export const REMOTE_SETTING_DEFAULTS = {
    backendApiUrl: '',
    skipKnownHostsCheck: true,
    historyLimit: 5,
    statusSyncInterval: 5,
} as const;

export interface RemoteSettings {
    backendApiUrl: string;
    skipKnownHostsCheck: boolean;
    historyLimit: number;
    statusSyncInterval: number;
}

export function getRemoteSettings(
    configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(REMOTE_CONFIGURATION_SECTION)
): RemoteSettings {
    const backendApiUrl = configuration.get<unknown>('backendApiUrl', REMOTE_SETTING_DEFAULTS.backendApiUrl);
    const skipKnownHostsCheck = configuration.get<unknown>('skipKnownHostsCheck', REMOTE_SETTING_DEFAULTS.skipKnownHostsCheck);
    const historyLimit = configuration.get<unknown>('historyLimit', REMOTE_SETTING_DEFAULTS.historyLimit);
    const statusSyncInterval = configuration.get<unknown>('statusSyncInterval', REMOTE_SETTING_DEFAULTS.statusSyncInterval);

    return {
        backendApiUrl: typeof backendApiUrl === 'string'
            ? backendApiUrl.trim()
            : REMOTE_SETTING_DEFAULTS.backendApiUrl,
        skipKnownHostsCheck: typeof skipKnownHostsCheck === 'boolean'
            ? skipKnownHostsCheck
            : REMOTE_SETTING_DEFAULTS.skipKnownHostsCheck,
        historyLimit: typeof historyLimit === 'number' && Number.isInteger(historyLimit) && historyLimit >= 0
            ? historyLimit
            : REMOTE_SETTING_DEFAULTS.historyLimit,
        statusSyncInterval: typeof statusSyncInterval === 'number' && Number.isFinite(statusSyncInterval) && statusSyncInterval > 0
            ? statusSyncInterval
            : REMOTE_SETTING_DEFAULTS.statusSyncInterval,
    };
}
