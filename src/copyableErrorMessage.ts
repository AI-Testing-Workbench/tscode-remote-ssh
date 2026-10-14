import * as vscode from 'vscode';

const COPY_ACTION = '复制';

export async function showCopyableErrorMessage(
    message: string,
    options?: vscode.MessageOptions,
    ...actions: string[]
): Promise<string | undefined> {
    const selectedAction = options
        ? await vscode.window.showErrorMessage(message, options, COPY_ACTION, ...actions)
        : await vscode.window.showErrorMessage(message, COPY_ACTION, ...actions);

    if (selectedAction !== COPY_ACTION) {
        return selectedAction;
    }

    try {
        await vscode.env.clipboard.writeText(message);
    } catch (error) {
        console.error('复制错误信息失败', error);
    }
    return undefined;
}
