import { vi } from 'vitest';
import * as vscode from 'vscode';

type ProgressTask = <R>(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<R>;

let $password: string = '';

const commands = {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};

const authentication = {
    getSession: vi.fn(),
};

const configurationValues = new Map<string, unknown>();

function setConfigurationValue(section: string, key: string, value: unknown) {
    configurationValues.set(`${section}.${key}`, value);
}

function resetConfiguration() {
    configurationValues.clear();
    workspace.workspaceFolders = undefined;
    workspace.workspaceFile = undefined;
}

const env = {
    appRoot: '/bin/vscodium/app',
    clipboard: {
        writeText: vi.fn(() => Promise.resolve())
    }
};

class ExtensionContext {
    extensionPath = '/data/vscodium/extensions/open-remote-ssh';
    environmentVariableCollection = {
        persistent: false,
        replace: vi.fn(),
    };
}

enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15
}

class RemoteAuthorityResolverContext {
    resolveAttempt = 0;
}

class RemoteAuthorityResolverError extends Error {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static NotAvailable(message?: string, _handled?: boolean): RemoteAuthorityResolverError {
        return new RemoteAuthorityResolverError(message ?? 'NotAvailable');
    }

    static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError {
        return new RemoteAuthorityResolverError(message ?? 'TemporarilyNotAvailable');
    }

    constructor(message?: string) {
        super(message);
    }
}

class ResolvedAuthority {
    constructor(readonly host: string, readonly port: number, readonly connectionToken?: string) {
    }
}

const version = '1.126.04524';

const window = {
    createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn()
    })),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    createQuickPick: vi.fn(),
    setPassword: (password: string) => {
        $password = password;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInputBox: async (options?: vscode.InputBoxOptions, _token?: vscode.CancellationToken) => {
        if(options?.title?.startsWith('Enter password for')) {
            return $password;
        }

        return undefined;
    },

    withProgress: vi.fn((_options: vscode.ProgressOptions, task: ProgressTask) => {
        const mockProgressReporter = {
            report: vi.fn(),
            then: vi.fn(),
        };

        return task(mockProgressReporter, {} as vscode.CancellationToken) as Promise<unknown>;
    }),
    createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

const Uri = {
    from: vi.fn((components: { scheme: string; authority: string; path: string }) => components),
};

const workspace = {
    workspaceFolders: undefined as readonly vscode.WorkspaceFolder[] | undefined,
    workspaceFile: undefined as vscode.Uri | undefined,
    getConfiguration: vi.fn((section?: string) => ({
        get: vi.fn((key: string, defaultValue?: unknown) => {
            const settingKey = `${section}.${key}`;
            return configurationValues.has(settingKey)
                ? configurationValues.get(settingKey)
                : key === 'configFile' ? '~/.local/share/testagent' : defaultValue;
        }),
        update: vi.fn(() => Promise.resolve())
    })),
    registerResourceLabelFormatter: vi.fn(),
    registerRemoteAuthorityResolver: vi.fn(() => ({ dispose: vi.fn() })),
};

export {
    authentication,
    commands,
    env,
    ExtensionContext,
    ProgressLocation,
    RemoteAuthorityResolverContext,
    RemoteAuthorityResolverError,
    ResolvedAuthority,
    resetConfiguration,
    setConfigurationValue,
    Uri,
    window,
    version,
    workspace,
};
