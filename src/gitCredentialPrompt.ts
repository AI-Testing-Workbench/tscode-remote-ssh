import * as vscode from 'vscode';
import type { GitCredentialSubmitRequest } from './api/models';
import type { GitConfigReader, GitIdentity } from './gitConfig';

export interface GitCredentialPromptOptions {
    identityReader: Pick<GitConfigReader, 'read'>;
    showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick?: (
        items: readonly string[],
        options: vscode.QuickPickOptions,
    ) => Thenable<string | undefined>;
    showErrorMessage?: (message: string) => Thenable<unknown>;
    onCancel?: () => Thenable<unknown> | void;
}

const DO_NOT_PERSIST = '否';
const PERSIST = '是';

export async function promptForGitCredentials(
    options: GitCredentialPromptOptions,
): Promise<GitCredentialSubmitRequest | undefined> {
    const showInputBox = options.showInputBox ?? (inputOptions => vscode.window.showInputBox(inputOptions));
    const showQuickPick = options.showQuickPick ?? ((items, pickOptions) => vscode.window.showQuickPick(items, pickOptions));
    const showErrorMessage = options.showErrorMessage ?? (message => vscode.window.showErrorMessage(message));
    const cancel = async (): Promise<undefined> => {
        try {
            await options.onCancel?.();
        } catch {
            // A failed cancellation report must not expose transport details or block the prompt flow.
        }
        return undefined;
    };
    const identity = await readIdentity(options.identityReader);

    const username = await promptRequired(showInputBox, showErrorMessage, {
        title: '请输入码云用户名',
        prompt: '',
        value: identity.username,
        emptyMessage: '码云用户名不能为空',
    }, value => value.trim());
    if (username === undefined) {
        return cancel();
    }

    const email = await showInputBox({
        title: '请输入码云邮箱',
        prompt: '(可选)',
        value: identity.email,
        ignoreFocusOut: true,
    });
    if (email === undefined) {
        return cancel();
    }

    const password = await promptRequired(showInputBox, showErrorMessage, {
        title: '请输入码云密码 (将会加密使用)',
        prompt: '',
        password: true,
        ignoreFocusOut: true,
        emptyMessage: '码云密码不能为空',
    }, value => value, true);
    if (password === undefined) {
        return cancel();
    }

    const persistChoice = await showQuickPick([DO_NOT_PERSIST, PERSIST], {
        title: '是否加密储存码云信息？储存后将无需进行码云认证',
        placeHolder: DO_NOT_PERSIST,
        canPickMany: false,
        ignoreFocusOut: true,
    });
    if (persistChoice !== DO_NOT_PERSIST && persistChoice !== PERSIST) {
        return cancel();
    }

    return {
        type: 'password',
        git_username: username,
        git_email: email.trim(),
        git_password: password,
        persist: persistChoice === PERSIST,
    };
}

async function readIdentity(identityReader: Pick<GitConfigReader, 'read'>): Promise<GitIdentity> {
    try {
        return await identityReader.read();
    } catch {
        return { username: '', email: '' };
    }
}

async function promptRequired(
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>,
    showErrorMessage: (message: string) => Thenable<unknown>,
    inputOptions: vscode.InputBoxOptions & { emptyMessage: string },
    normalize: (value: string) => string,
    cancelOnEmpty = false,
): Promise<string | undefined> {
    const { emptyMessage, ...options } = inputOptions;
    while (true) {
        const value = await showInputBox(options);
        if (value === undefined) {
            return undefined;
        }
        const normalized = normalize(value);
        if (normalized) {
            return normalized;
        }
        await showErrorMessage(emptyMessage);
        if (cancelOnEmpty) {
            return undefined;
        }
    }
}
