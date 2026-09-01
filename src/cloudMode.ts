import * as fs from 'node:fs';

export const CLOUD_MODE_ENVIRONMENT_VARIABLE = 'TESTAGENT_CLOUD_MODE';
export const CLOUD_MODE_MARKER_PATH = '/etc/tscode-cloud-mode';

export interface CloudModeOptions {
    environment?: NodeJS.ProcessEnv;
    markerPath?: string;
    fileExists?: (path: string) => boolean;
    onFileCheckError?: (error: unknown) => void;
}

export function detectCloudMode(options: CloudModeOptions = {}): boolean {
    const environment = options.environment ?? process.env;
    if (environment[CLOUD_MODE_ENVIRONMENT_VARIABLE] === '1') {
        return true;
    }

    const fileExists = options.fileExists ?? fs.existsSync;
    const markerPath = options.markerPath ?? CLOUD_MODE_MARKER_PATH;
    try {
        return fileExists(markerPath);
    } catch (error) {
        if (options.onFileCheckError) {
            options.onFileCheckError(error);
        } else {
            console.warn('检查云端模式标记文件失败，按非云端模式处理');
        }
        return false;
    }
}

export function initializeCloudMode(options: CloudModeOptions = {}): boolean {
    cachedCloudMode = detectCloudMode(options);
    return cachedCloudMode;
}

export function isCloudMode(options?: CloudModeOptions): boolean {
    if (cachedCloudMode === undefined) {
        cachedCloudMode = detectCloudMode(options);
    }
    return cachedCloudMode;
}

export function resetCloudModeCache(): void {
    cachedCloudMode = undefined;
}

let cachedCloudMode: boolean | undefined;
