import * as vscode from 'vscode';
import { formatContainerInitializationError } from './containerInitializationPoller';
import { showCopyableErrorMessage } from './copyableErrorMessage';

export function withContainerCreationProgress<T>(task: () => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({
        title: '正在创建云端沙箱 服务...',
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
    }, task));
}

export function showContainerCreationSuccess(): void {
    void vscode.window.showInformationMessage('云端沙箱 服务创建成功');
}

export function showContainerCreationError(error: unknown, copyable = true): void {
    const message = formatContainerInitializationError(error);
    if (copyable) {
        void showCopyableErrorMessage(message, { modal: true });
        return;
    }
    void vscode.window.showErrorMessage(message, { modal: true });
}
