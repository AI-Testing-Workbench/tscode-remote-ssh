import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showCopyableErrorMessage } from '../src/copyableErrorMessage';

const showErrorMessage = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;
const writeText = vscode.env.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;

describe('showCopyableErrorMessage', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        showErrorMessage.mockReset();
        writeText.mockReset().mockResolvedValue(undefined);
    });

    it('places Copy before existing actions and copies the exact displayed text', async () => {
        const message = 'service-1 endpoint 无效 (错误码: invalid_endpoint)';
        showErrorMessage.mockResolvedValue('复制');

        await expect(showCopyableErrorMessage(message, { modal: true }, '重试', '关闭连接')).resolves.toBeUndefined();

        expect(showErrorMessage).toHaveBeenCalledWith(
            message,
            { modal: true },
            '复制',
            '重试',
            '关闭连接',
        );
        expect(writeText).toHaveBeenCalledWith(message);
    });

    it('preserves existing action results and leaves the clipboard unchanged', async () => {
        showErrorMessage.mockResolvedValue('重试');

        await expect(showCopyableErrorMessage('连接失败', { modal: true }, '重试', '关闭连接'))
            .resolves.toBe('重试');

        expect(writeText).not.toHaveBeenCalled();
    });

    it('adds Copy to non-modal error notifications', async () => {
        showErrorMessage.mockResolvedValue('复制');

        await showCopyableErrorMessage('后端请求失败');

        expect(showErrorMessage).toHaveBeenCalledWith('后端请求失败', '复制');
        expect(writeText).toHaveBeenCalledWith('后端请求失败');
    });

    it('does not let clipboard failures replace the original error interaction', async () => {
        const clipboardError = new Error('clipboard unavailable');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        showErrorMessage.mockResolvedValue('复制');
        writeText.mockRejectedValue(clipboardError);

        await expect(showCopyableErrorMessage('错误文本')).resolves.toBeUndefined();

        expect(console.error).toHaveBeenCalledWith('复制错误信息失败', clipboardError);
    });
});
