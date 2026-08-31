import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: Record<string, unknown>;

export const DISTRO_COMMIT = 'testagent';

async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
    }

    return vscodeProductJson;
}

export type IServerConfig = {
    serverApplicationName: string;
    serverDataFolderName: string;
};

export async function getVSCodeServerConfig(): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    return {
        serverApplicationName: productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
    };
}
