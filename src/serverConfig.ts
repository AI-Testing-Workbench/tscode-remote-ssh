import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: Record<string, unknown>;

async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
    }

    return vscodeProductJson;
}

export type ServerValidation = 'force' | 'skip' | 'strict';

export type IServerConfig = {
    commit: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverValidation: ServerValidation;
};

export async function getVSCodeServerConfig(): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    const customServerBinaryName = vscode.workspace.getConfiguration('remote.SSH').get<string>('serverBinaryName', '');
    const serverValidation = vscode.workspace.getConfiguration('remote.SSH').get<ServerValidation>('serverValidation', 'strict');

    return {
        commit: productJson.commit as string,
        serverApplicationName: customServerBinaryName || productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        serverValidation,
    };
}
