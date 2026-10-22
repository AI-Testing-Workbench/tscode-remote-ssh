import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: Record<string, unknown>;

export const DISTRO_COMMIT = 'tscode';

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
    clientCommit: string;
};

export async function getVSCodeServerConfig(): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    return {
        serverApplicationName: productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        clientCommit: getClientCommit(productJson.commit),
    };
}

function getClientCommit(commit: unknown): string {
    if (typeof commit !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(commit)) {
        throw new Error('Local VS Code product.json does not contain a valid commit');
    }

    return commit;
}
