import * as vscode from 'vscode';
import type { GitCredentialSubmitRequest, GitStatus } from './api/models';
import type { GitConfigReader, GitIdentity } from './gitConfig';

export interface GitCredentialPromptOptions {
    identityReader: Pick<GitConfigReader, 'read'>;
    showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick?: (
        items: readonly string[],
        options: vscode.QuickPickOptions,
    ) => Thenable<string | undefined>;
    createInputBox?: () => vscode.InputBox;
    showErrorMessage?: (message: string, options?: vscode.MessageOptions) => Thenable<unknown>;
    onCancel?: () => Thenable<unknown> | void;
    gitStatus?: Extract<GitStatus, 'credential_required' | 'credential_rejected'>;
}

const DO_NOT_PERSIST = '否';
const PERSIST = '是';

export async function promptForGitCredentials(
    options: GitCredentialPromptOptions,
): Promise<GitCredentialSubmitRequest | undefined> {
    const showInputBox = options.showInputBox ?? (inputOptions => vscode.window.showInputBox(inputOptions));
    const showQuickPick = options.showQuickPick ?? ((items, pickOptions) => vscode.window.showQuickPick(items, pickOptions));
    const createInputBox = options.createInputBox;
    const showPasswordInputBox = createInputBox
        ? (inputOptions: vscode.InputBoxOptions) => promptWithVisibilityToggle(inputOptions, createInputBox)
        : options.showInputBox ?? (inputOptions => promptWithVisibilityToggle(inputOptions));
    const showErrorMessage = options.showErrorMessage ?? ((message, messageOptions) => (
        messageOptions === undefined
            ? vscode.window.showErrorMessage(message)
            : vscode.window.showErrorMessage(message, messageOptions)
    ));
    if (options.gitStatus === 'credential_rejected') {
        await showErrorMessage('码云凭证输入有误或者缓存过期\n请检查码云用户名是否为工号，以及密码是否正确\n并再次重试', { modal: true });
    }
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
        title: '请输入码云用户名 (请仅输入工号，不要附加姓名)',
        prompt: '',
        value: identity.username,
        ignoreFocusOut: true,
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

    const password = await promptRequired(showPasswordInputBox, showErrorMessage, {
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

function promptWithVisibilityToggle(
    options: vscode.InputBoxOptions,
    createInputBox: () => vscode.InputBox = () => vscode.window.createInputBox(),
): Promise<string | undefined> {
    const inputBox = createInputBox();
    inputBox.title = options.title;
    inputBox.prompt = options.prompt;
    inputBox.placeholder = options.placeHolder;
    inputBox.value = options.value ?? '';
    inputBox.password = true;
    inputBox.ignoreFocusOut = true;
    inputBox.buttons = [createVisibilityButton(false)];

    return new Promise(resolve => {
        let resolved = false;
        const finish = (value: string | undefined): void => {
            if (resolved) {
                return;
            }
            resolved = true;
            inputBox.dispose();
            resolve(value);
        };

        inputBox.onDidAccept(() => finish(inputBox.value));
        inputBox.onDidHide(() => finish(undefined));
        inputBox.onDidTriggerButton(() => {
            inputBox.password = !inputBox.password;
            inputBox.buttons = [createVisibilityButton(!inputBox.password)];
        });
        inputBox.show();
    });
}

function createVisibilityButton(passwordVisible: boolean): vscode.QuickInputButton {
    return {
        iconPath: new vscode.ThemeIcon(passwordVisible ? 'eye-closed' : 'eye'),
        tooltip: passwordVisible ? '隐藏密码' : '显示密码',
    };
}

async function promptRequired(
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>,
    showErrorMessage: (message: string, options?: vscode.MessageOptions) => Thenable<unknown>,
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
        if (cancelOnEmpty) {
            void showErrorMessage(emptyMessage);
            return undefined;
        }
        await showErrorMessage(emptyMessage);
    }
}
