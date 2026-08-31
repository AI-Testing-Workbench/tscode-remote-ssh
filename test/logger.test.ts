import { expect, it } from 'vitest';
import { Log } from '../src/common/logger';
import * as vscode from './mocks/vscode';

it('copies the current output to the clipboard', async () => {
    vscode.env.clipboard.writeText.mockClear();

    const logger = new Log('TestAgent - Remote');
    logger.info('first log line');
    logger.error('second log line', { reason: 'test' });

    await logger.copyToClipboard();

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledOnce();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('first log line'));
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('second log line'));
});
