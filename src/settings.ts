import * as vscode from 'vscode';
import * as os from 'node:os';

export const REMOTE_CONFIGURATION_SECTION = 'testagnet.remote';

export const REMOTE_SETTING_DEFAULTS = {
    backendApiUrl: '',
    userName: 'root',
    skipKnownHostsCheck: true,
    historyLimit: 5,
    statusSyncInterval: 5,
    debug: false,
    disableClientValidation: true,
} as const;

export interface RemoteSettings {
    backendApiUrl: string;
    userName: string;
    skipKnownHostsCheck: boolean;
    historyLimit: number;
    statusSyncInterval: number;
    debug: boolean;
    disableClientValidation: boolean;
}

export function getRemoteSettings(
    configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(REMOTE_CONFIGURATION_SECTION)
): RemoteSettings {
    const backendApiUrl = configuration.get<unknown>('backendApiUrl', REMOTE_SETTING_DEFAULTS.backendApiUrl);
    const userName = configuration.get<unknown>('userName', REMOTE_SETTING_DEFAULTS.userName);
    const skipKnownHostsCheck = configuration.get<unknown>('skipKnownHostsCheck', REMOTE_SETTING_DEFAULTS.skipKnownHostsCheck);
    const historyLimit = configuration.get<unknown>('historyLimit', REMOTE_SETTING_DEFAULTS.historyLimit);
    const statusSyncInterval = configuration.get<unknown>('statusSyncInterval', REMOTE_SETTING_DEFAULTS.statusSyncInterval);
    const debug = configuration.get<unknown>('debug', REMOTE_SETTING_DEFAULTS.debug);
    const disableClientValidation = configuration.get<unknown>('disableClientValidation', REMOTE_SETTING_DEFAULTS.disableClientValidation);

    return {
        backendApiUrl: typeof backendApiUrl === 'string'
            ? backendApiUrl.trim()
            : REMOTE_SETTING_DEFAULTS.backendApiUrl,
        userName: typeof userName === 'string'
            ? userName.trim()
            : REMOTE_SETTING_DEFAULTS.userName,
        skipKnownHostsCheck: typeof skipKnownHostsCheck === 'boolean'
            ? skipKnownHostsCheck
            : REMOTE_SETTING_DEFAULTS.skipKnownHostsCheck,
        historyLimit: typeof historyLimit === 'number' && Number.isInteger(historyLimit) && historyLimit >= 0
            ? historyLimit
            : REMOTE_SETTING_DEFAULTS.historyLimit,
        statusSyncInterval: typeof statusSyncInterval === 'number' && Number.isFinite(statusSyncInterval) && statusSyncInterval > 0
            ? statusSyncInterval
            : REMOTE_SETTING_DEFAULTS.statusSyncInterval,
        debug: typeof debug === 'boolean' ? debug : REMOTE_SETTING_DEFAULTS.debug,
        disableClientValidation: typeof disableClientValidation === 'boolean'
            ? disableClientValidation
            : REMOTE_SETTING_DEFAULTS.disableClientValidation,
    };
}

export function getEffectiveRemoteUserName(configuredUserName: string): string {
    const normalizedUserName = configuredUserName.trim();
    if (normalizedUserName) {
        return normalizedUserName;
    }

    try {
        const currentUserName = os.userInfo().username.trim();
        if (currentUserName) {
            return currentUserName;
        }
    } catch {
        // Fall back to the configured default when the OS username is unavailable.
    }
    return REMOTE_SETTING_DEFAULTS.userName;
}
