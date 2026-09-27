import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_PREFIX = '[TestAgentConfigSync]';

/** Minimal SSH surface needed to sync files; satisfied by {@link SSHConnection}. */
export interface TestagentConfigConnection {
    exec(cmd: string): Promise<{ stdout: string; stderr: string }>;
}

/** Minimal logger surface; satisfied by the extension's `Log`. */
export interface TestagentConfigLogger {
    trace(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
}

/** A local file to copy into the sandbox, with its absolute remote destination. */
export interface TestagentConfigSyncEntry {
    localPath: string;
    remotePath: string;
}

export interface CopyTestagentConfigOptions {
    /** Override the local config root; defaults to {@link localTestagentConfigRoot}. Test seam. */
    localConfigRoot?: string;
    /** Override the local data root; defaults to {@link localTestagentDataRoot}. Test seam. */
    localDataRoot?: string;
    /**
     * Basenames to copy. Defaults to every known file. Lets the user disable
     * individual files (e.g. `testagent.jsonc`) to bisect a sandbox-side issue
     * without rebuilding the extension.
     */
    fileNames?: readonly string[];
}

/** Local TestAgent config root (`$XDG_CONFIG_HOME ?? ~/.config` + `testagent`). */
export function localTestagentConfigRoot(env: NodeJS.ProcessEnv = process.env, homeDirectory: string = os.homedir()): string {
    return path.join(env.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'testagent');
}

/** Local TestAgent data root (`$XDG_DATA_HOME ?? ~/.local/share` + `testagent`). */
export function localTestagentDataRoot(env: NodeJS.ProcessEnv = process.env, homeDirectory: string = os.homedir()): string {
    return path.join(env.XDG_DATA_HOME || path.join(homeDirectory, '.local', 'share'), 'testagent');
}

const CONFIG_FILE_NAMES = ['testagent.jsonc'];
// `external-user.json` is deliberately excluded: it holds the sandbox's platform
// identity/token, and overwriting it with the local machine's copy breaks the
// sandbox user context (the remote backend then fails on the first session).
const DATA_FILE_NAMES = ['auth.json', 'env-vars.json'];

/** Every file the sync knows about; also the default selection. */
export const TESTAGENT_CONFIG_FILE_NAMES: readonly string[] = [...CONFIG_FILE_NAMES, ...DATA_FILE_NAMES];

/** Build the explicit local→remote file map for the known TestAgent config files. */
export function buildTestagentConfigSyncEntries(
    localConfigRoot: string,
    localDataRoot: string,
    remoteConfigRoot: string,
    remoteDataRoot: string,
): TestagentConfigSyncEntry[] {
    return [
        ...CONFIG_FILE_NAMES.map(name => ({ localPath: path.join(localConfigRoot, name), remotePath: `${remoteConfigRoot}/${name}` })),
        ...DATA_FILE_NAMES.map(name => ({ localPath: path.join(localDataRoot, name), remotePath: `${remoteDataRoot}/${name}` })),
    ];
}

/**
 * Resolve the remote config/data roots in the sandbox shell, honoring the
 * sandbox's `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` when set and falling back to
 * `$HOME/.config` and `$HOME/.local/share` otherwise.
 */
export async function resolveRemoteTestagentRoots(connection: TestagentConfigConnection): Promise<{ configRoot: string; dataRoot: string }> {
    const command = `printf '%s\\n' "\${XDG_CONFIG_HOME:-$HOME/.config}/testagent" "\${XDG_DATA_HOME:-$HOME/.local/share}/testagent"`;
    const { stdout } = await connection.exec(command);
    const [configRoot, dataRoot] = stdout.split('\n').map(line => line.trim()).filter(Boolean);
    if (!configRoot || !dataRoot) {
        throw new Error(`${LOG_PREFIX} could not resolve remote config/data roots from output: ${JSON.stringify(stdout)}`);
    }
    return { configRoot, dataRoot };
}

/**
 * Copy the known local TestAgent config files into the sandbox. Missing local
 * files are skipped and every failure is logged rather than thrown, so config
 * sync can never block connecting to the sandbox.
 */
export async function copyTestagentConfigToRemote(
    connection: TestagentConfigConnection,
    logger: TestagentConfigLogger,
    options: CopyTestagentConfigOptions = {},
): Promise<void> {
    let remoteRoots: { configRoot: string; dataRoot: string };
    try {
        remoteRoots = await resolveRemoteTestagentRoots(connection);
    } catch (error) {
        logger.error(`${LOG_PREFIX} Failed to resolve remote TestAgent config roots`, error);
        return;
    }

    const allEntries = buildTestagentConfigSyncEntries(
        options.localConfigRoot ?? localTestagentConfigRoot(),
        options.localDataRoot ?? localTestagentDataRoot(),
        remoteRoots.configRoot,
        remoteRoots.dataRoot,
    );
    const entries = options.fileNames
        ? allEntries.filter(entry => options.fileNames!.includes(path.posix.basename(entry.remotePath)))
        : allEntries;

    let copied = 0;
    for (const entry of entries) {
        let content: Buffer;
        try {
            content = await fs.promises.readFile(entry.localPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                logger.trace(`${LOG_PREFIX} Skipping missing local file ${entry.localPath}`);
                continue;
            }
            logger.error(`${LOG_PREFIX} Failed to read local file ${entry.localPath}`, error);
            continue;
        }

        const remoteDir = path.posix.dirname(entry.remotePath);
        const encoded = content.toString('base64');
        const command = `mkdir -p ${shellQuote(remoteDir)} && chmod 700 ${shellQuote(remoteDir)}`
            + ` && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(entry.remotePath)}`
            + ` && chmod 600 ${shellQuote(entry.remotePath)}`;
        try {
            await connection.exec(command);
            copied += 1;
            logger.trace(`${LOG_PREFIX} Copied ${entry.localPath} -> ${entry.remotePath}`);
        } catch (error) {
            logger.error(`${LOG_PREFIX} Failed to copy ${entry.localPath} -> ${entry.remotePath}`, error);
        }
    }
    logger.info(`${LOG_PREFIX} Synced ${copied}/${entries.length} TestAgent config file(s) to the sandbox`);
}

/** Escape a string for use as a single POSIX shell argument. */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, '\'\\\'\'')}'`;
}
