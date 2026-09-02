import * as fs from 'fs';
import * as os from 'os';

const homeDir = os.homedir();

export async function exists(path: string) {
    try {
        await fs.promises.access(path);
        return true;
    } catch {
        return false;
    }
}

export function untildify(path: string){
    return expandPath(path);
}

export function expandPath(path: string, homeDirectory: string = homeDir): string {
    return path
        .replace(/^~(?=$|\/|\\)/, homeDirectory)
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g, (match, bracedName, plainName, windowsName) => {
            const variableName = bracedName || plainName || windowsName;
            return process.env[variableName] ?? match;
        });
}

export function normalizeToSlash(path: string) {
    return path.replace(/\\/g, '/');
}
