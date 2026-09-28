import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as stream from 'stream';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import { Log } from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { gatherIdentityFiles, SSHKey } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError } from './serverSetup';
import { isWindows } from './common/platform';
import {
    createDebugEnvironmentConfirmer,
    DebugEnvironmentPreparationCancelledError,
    formatContainerEndpoint,
    InvalidContainerEndpointError,
    parseContainerEndpoint,
} from './containerEndpoint';
import { getEffectiveRemoteUserName, getRemoteSettings } from './settings';
import { GIT_CLONE_COMMAND } from './ssh/gitCloneCommand';
import { copyTestagentConfigToRemote, TESTAGENT_CONFIG_FILE_NAMES } from './testagentConfigSync';
import * as os from 'os';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;
const GIT_CLONE_SSH_CONNECT_ATTEMPTS = 5;
const GIT_CLONE_SSH_RETRY_DELAY_MS = 1000;

function isSSHReadinessError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const sshError = error as { code?: unknown; level?: unknown };
    return sshError.level === 'client-timeout'
        || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(String(sshError.code));
}

function waitWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new Error('Git clone execution was cancelled'));
    }
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(new Error('Git clone execution was cancelled'));
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

/**
 * Split a ProxyCommand value into argv tokens.
 *
 * ssh-config v5.0.0 reassembles ProxyCommand's value into a single string (to
 * preserve quoting across the param boundary), but the spawn code expects
 * individual argv tokens. Calling `[].concat(someString)` does NOT split the
 * string — it wraps it, so `spawn()` ends up receiving the whole command
 * line as the executable path and fails with ENOENT. See
 * https://github.com/jeanp413/open-remote-ssh/issues/271 and
 * https://github.com/jeanp413/open-remote-ssh/issues/273.
 *
 * This helper mirrors OpenSSH's own ProxyCommand tokenization:
 * - whitespace separates tokens (outside quotes)
 * - double quotes group a single token
 * - backslash escapes the next character
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
function splitProxyCommand(value: string | string[]): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (ch === '\\' && i + 1 < value.length) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            i += 1;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
            i += 1;
            continue;
        }
        cur += ch;
        hasToken = true;
        i += 1;
    }
    if (hasToken) {out.push(cur);}
    return out;
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private proxyConnections: SSHConnection[] = [];
    private sshConnection: SSHConnection | undefined;
    private sshAgentSock: string | undefined;
    private proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;
    private agentForwardSession: ssh2.ClientChannel | undefined;
    private activeHost: string | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private labelFormatterDisposable: vscode.Disposable | undefined;
    private readonly confirmDebugEnvironmentOnce: (containerId: string) => Promise<void>;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
        this.confirmDebugEnvironmentOnce = createDebugEnvironmentConfirmer(
            (message, options, ...items) => vscode.window.showWarningMessage(message, options, ...items),
        );
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const separator = authority.indexOf('+');
        const type = separator >= 0 ? authority.slice(0, separator) : authority;
        const dest = separator >= 0 ? authority.slice(separator + 1) : '';
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('tscode.remote');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const copyTestagentConfig = remoteSSHconfig.get<boolean>('copyTestagentConfig', false)!;
        const copyTestagentConfigFilesSetting = remoteSSHconfig.get<string[]>('copyTestagentConfigFiles', [...TESTAGENT_CONFIG_FILE_NAMES]);
        const copyTestagentConfigFiles = Array.isArray(copyTestagentConfigFilesSetting)
            ? copyTestagentConfigFilesSetting.filter((name): name is string => typeof name === 'string')
            : [...TESTAGENT_CONFIG_FILE_NAMES];

        return vscode.window.withProgress({
            title: `正在连接至 云端沙箱 服务...`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? sshHostConfig['HostName'].replace('%h', sshDest.hostname) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);
                const containerId = sshHostConfig['ContainerId'];
                if (containerId) {
                    const endpoint = formatContainerEndpoint(sshHostName, sshHostConfig['Port']);
                    if (!parseContainerEndpoint(endpoint)) {
                        throw new InvalidContainerEndpointError(containerId, endpoint);
                    }
                    if (getRemoteSettings().debug) {
                        await this.confirmDebugEnvironmentOnce(containerId);
                    }
                }

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = await this.connectSSH(
                    sshconfig,
                    sshDest,
                    sshHostConfig,
                    sshHostName,
                    sshUser,
                    sshPort,
                    connectTimeout,
                    enableAgentForwarding,
                );

                // Copy the local TestAgent config into the sandbox right after the SSH
                // handshake and before installCodeServer starts any remote process, so a
                // freshly provisioned sandbox does not have to be reconfigured by hand.
                if (copyTestagentConfig) {
                    await copyTestagentConfigToRemote(this.sshConnection!, this.logger, { fileNames: copyTestagentConfigFiles });
                }

                const envVariables: Record<string, string | null> = {};
                if (agentForward) {
                    // The agent-forwarding socket sshd creates is scoped to the ssh channel that
                    // requested it and is torn down as soon as that channel closes. The server
                    // install/start script runs on its own short-lived exec channel, so any
                    // SSH_AUTH_SOCK it reports is already stale by the time we get here. Keep a
                    // dedicated channel open for the lifetime of the connection instead, and use
                    // its socket path everywhere else (terminals, extension host). Agent
                    // forwarding is best-effort: a failure here must not prevent connecting.
                    try {
                        const remoteAgentSock = await this.openAgentForwardSession();
                        if (remoteAgentSock) {
                            envVariables['SSH_AUTH_SOCK'] = remoteAgentSock;
                        }
                    } catch (e) {
                        this.logger.error(`Failed to setup agent forwarding`, e);
                    }
                }

                const installResult = await installCodeServer(
                    this.sshConnection!,
                    defaultExtensions,
                    [],
                    remotePlatformMap[sshDest.hostname],
                    remoteServerListenOnSocket,
                    this.logger,
                    this.context.extensionPath
                );

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                if (enableDynamicForwarding) {
                    const socksPort = await findRandomPort();
                    this.socksTunnel = await this.sshConnection!.addTunnel({
                        name: `ssh_tunnel_socks_${socksPort}`,
                        localPort: socksPort,
                        socks: true
                    });
                }

                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: '云端沙箱 服务'
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
                resolvedResult.extensionHostEnv = envVariables;
                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                if (e instanceof InvalidContainerEndpointError) {
                    await vscode.window.showErrorMessage(e.message, { modal: true });
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e.message);
                }

                if (e instanceof DebugEnvironmentPreparationCancelledError) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e.message);
                }

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = '关闭连接';
                    const retry = '重试';
                    const copyLog = '复制日志';
                    const result = await vscode.window.showErrorMessage(`连接至 云端沙箱 服务 "${sshDest.hostname}" 时失败，\n请重试或者复制日志并联系支持人员。`, { modal: true }, retry, copyLog, closeRemote);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    } else if (result === copyLog) {
                        try {
                            await this.logger.copyToClipboard();
                            await vscode.commands.executeCommand('workbench.action.remote.close');
                        } catch {
                            // Ignore clipboard errors and preserve the original connection error.
                        }
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    /**
     * Return an SFTP subsystem for the currently authenticated remote host.
     * The resolver owns the SSH connection; callers only own the subsystem and
     * must end it after their transfer completes.
     */
    public async getSftp(host: string): Promise<ssh2.SFTPWrapper> {
        const normalizedHost = typeof host === 'string' ? host.trim().toLowerCase() : '';
        if (!this.sshConnection || !this.activeHost || normalizedHost !== this.activeHost.trim().toLowerCase()) {
            throw new Error(`容器 "${host}" 尚未建立连接`);
        }
        return this.sshConnection.sftp();
    }

    public async executeGitCloneScript(
        containerId: string,
        hostAlias: string,
        endpoint: string | null | undefined,
        signal?: AbortSignal,
    ): Promise<void> {
        const settings = getRemoteSettings();
        const parsedEndpoint = parseContainerEndpoint(endpoint, { allowDebugProxy: settings.debug });
        if (!parsedEndpoint) {
            throw new InvalidContainerEndpointError(containerId, endpoint);
        }
        if (settings.debug) {
            await this.confirmDebugEnvironmentOnce(containerId);
        }
        if (signal?.aborted) {
            throw new Error('Git clone execution was cancelled');
        }

        const commandResolver = new RemoteSSHResolver(this.context, this.logger);
        let closeConnectionPromise: Promise<void> | undefined;
        const closeConnection = () => closeConnectionPromise ??= commandResolver.closeCommandConnection();
        const onAbort = () => { void closeConnection(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const sshconfig = await SSHConfiguration.loadFromFS();
            const sshHostConfig = sshconfig.getHostConfiguration(hostAlias);
            const sshHostName = parsedEndpoint.host;
            const sshUser = getEffectiveRemoteUserName(settings.userName);
            const remoteSSHconfig = vscode.workspace.getConfiguration('tscode.remote');
            const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
            const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
            commandResolver.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
            commandResolver.sshAgentSock = commandResolver.sshAgentSock ? untildify(commandResolver.sshAgentSock) : undefined;
            const readinessConnectTimeout = Math.max(1, Math.min(connectTimeout, 10));
            let connected = false;
            for (let attempt = 1; attempt <= GIT_CLONE_SSH_CONNECT_ATTEMPTS; attempt += 1) {
                try {
                    await commandResolver.connectSSH(
                        sshconfig,
                        new SSHDestination(hostAlias, sshUser, parsedEndpoint.port),
                        sshHostConfig,
                        sshHostName,
                        sshUser,
                        parsedEndpoint.port,
                        readinessConnectTimeout,
                        enableAgentForwarding,
                        signal,
                    );
                    connected = true;
                    break;
                } catch (error) {
                    await closeConnection();
                    closeConnectionPromise = undefined;
                    if (signal?.aborted || attempt === GIT_CLONE_SSH_CONNECT_ATTEMPTS || !isSSHReadinessError(error)) {
                        throw error;
                    }
                    this.logger.trace(`Container SSH is not ready yet; retry ${attempt}/${GIT_CLONE_SSH_CONNECT_ATTEMPTS - 1}`);
                    await waitWithAbort(GIT_CLONE_SSH_RETRY_DELAY_MS, signal);
                }
            }
            if (!connected) {
                throw new Error('Container SSH did not become ready');
            }
            if (signal?.aborted) {
                throw new Error('Git clone execution was cancelled');
            }
            await commandResolver.executeRemoteCommand(GIT_CLONE_COMMAND, signal);
        } finally {
            signal?.removeEventListener('abort', onAbort);
            await closeConnection();
        }
    }

    private async connectSSH(
        sshconfig: SSHConfiguration,
        sshDest: SSHDestination,
        sshHostConfig: Record<string, string>,
        sshHostName: string,
        sshUser: string,
        sshPort: number,
        connectTimeout: number,
        enableAgentForwarding: boolean,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
        const agent = agentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;
        const preferredAuthentications = sshHostConfig['PreferredAuthentications']
            ? sshHostConfig['PreferredAuthentications'].split(',').map(value => value.trim())
            : ['publickey', 'password', 'keyboard-interactive'];
        const identityFiles: string[] = (sshHostConfig['IdentityFile'] as unknown as string[]) || [];
        const identitiesOnly = (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
        const identityKeys = await gatherIdentityFiles(identityFiles, this.sshAgentSock, identitiesOnly, this.logger);
        if (signal?.aborted) {
            throw new Error('Git clone execution was cancelled');
        }

        let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;
        if (sshHostConfig['ProxyJump']) {
            const proxyJumps = sshHostConfig['ProxyJump'].split(',').filter(value => !!value.trim())
                .map(value => {
                    const proxy = SSHDestination.parse(value);
                    const proxyHostConfig = sshconfig.getHostConfiguration(proxy.hostname);
                    return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                });
            for (let i = 0; i < proxyJumps.length; i += 1) {
                if (signal?.aborted) {
                    throw new Error('Git clone execution was cancelled');
                }
                const [proxy, proxyHostConfig] = proxyJumps[i];
                const proxyHostName = proxyHostConfig['HostName'] || proxy.hostname;
                const proxyUser = proxyHostConfig['User'] || proxy.user || sshUser;
                const proxyPort = proxyHostConfig['Port'] ? parseInt(proxyHostConfig['Port'], 10) : (proxy.port || sshPort);
                const proxyAgentForward = enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const proxyAgent = proxyAgentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;
                const proxyIdentityFiles: string[] = (proxyHostConfig['IdentityFile'] as unknown as string[]) || [];
                const proxyIdentitiesOnly = (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const proxyIdentityKeys = await gatherIdentityFiles(proxyIdentityFiles, this.sshAgentSock, proxyIdentitiesOnly, this.logger);
                const proxyAuthHandler = this.getSSHAuthHandler(proxyUser, proxyHostName, proxyIdentityKeys, preferredAuthentications);
                const proxyConnection = new SSHConnection({
                    host: !proxyStream ? proxyHostName : undefined,
                    port: !proxyStream ? proxyPort : undefined,
                    sock: proxyStream,
                    username: proxyUser,
                    readyTimeout: connectTimeout * 1000,
                    strictVendor: false,
                    agentForward: proxyAgentForward,
                    agent: proxyAgent,
                    authHandler: (arg0, arg1, arg2) => (proxyAuthHandler(arg0, arg1, arg2), undefined),
                });
                this.proxyConnections.push(proxyConnection);
                const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                const destIP = nextProxyJump ? (nextProxyJump[1]['HostName'] || nextProxyJump[0].hostname) : sshHostName;
                const destPort = nextProxyJump
                    ? ((nextProxyJump[1]['Port'] && parseInt(nextProxyJump[1]['Port'], 10)) || nextProxyJump[0].port || 22)
                    : sshPort;
                proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, destIP, destPort);
            }
        } else if (sshHostConfig['ProxyCommand']) {
            let proxyArgs = splitProxyCommand(sshHostConfig['ProxyCommand'] as unknown as string | string[])
                .map(arg => arg.replace('%h', sshHostName).replace('%n', sshDest.hostname).replace('%p', sshPort.toString()).replace('%r', sshUser));
            let proxyCommand = proxyArgs.shift()!;
            let options = {};
            if (isWindows && /\.(bat|cmd)$/.test(proxyCommand)) {
                proxyCommand = `"${proxyCommand}"`;
                proxyArgs = proxyArgs.map(arg => arg.includes(' ') ? `"${arg}"` : arg);
                options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
            }
            this.logger.trace(`Spawning ProxyCommand: ${proxyCommand} ${proxyArgs.join(' ')}`);
            const child = cp.spawn(proxyCommand, proxyArgs, options);
            proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
            this.proxyCommandProcess = child;
        }

        const sshAuthHandler = this.getSSHAuthHandler(sshUser, sshHostName, identityKeys, preferredAuthentications);
        this.sshConnection = new SSHConnection({
            host: !proxyStream ? sshHostName : undefined,
            port: !proxyStream ? sshPort : undefined,
            sock: proxyStream,
            username: sshUser,
            readyTimeout: connectTimeout * 1000,
            strictVendor: false,
            agentForward,
            agent,
            authHandler: (arg0, arg1, arg2) => (sshAuthHandler(arg0, arg1, arg2), undefined),
        });
        if (signal?.aborted) {
            throw new Error('Git clone execution was cancelled');
        }
        await this.sshConnection.connect();
        this.activeHost = sshDest.hostname;
        return agentForward;
    }

    private async executeRemoteCommand(command: string, signal?: AbortSignal): Promise<void> {
        if (!this.sshConnection) {
            throw new Error('SSH connection is not available');
        }
        const channel = await this.sshConnection.execChannel(command);
        await new Promise<void>((resolve, reject) => {
            let exitCode: number | undefined;
            let settled = false;
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const finish = (error?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            const onAbort = () => {
                finish(new Error('Git clone execution was cancelled'));
                channel.close();
            };
            channel.on('data', () => undefined);
            channel.stderr.on('data', () => undefined);
            channel.on('exit', code => { exitCode = typeof code === 'number' ? code : undefined; });
            channel.once('error', error => finish(error));
            channel.once('close', () => {
                finish(exitCode === 0 ? undefined : new Error(`Git clone script exited with status ${exitCode ?? 'unknown'}`));
            });
            if (signal?.aborted) {
                onAbort();
            } else {
                signal?.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    private async closeCommandConnection(): Promise<void> {
        const closeTargets: Promise<unknown>[] = [];
        if (this.sshConnection) {
            closeTargets.push(this.sshConnection.close());
        }
        if (this.proxyConnections.length) {
            closeTargets.push(this.proxyConnections[0].close());
        }
        await Promise.allSettled(closeTargets);
        if (this.proxyCommandProcess && !this.proxyCommandProcess.killed) {
            this.proxyCommandProcess.kill();
        }
        this.sshConnection = undefined;
        this.proxyConnections = [];
        this.proxyCommandProcess = undefined;
        this.activeHost = undefined;
    }

    private openAgentForwardSession(): Promise<string | undefined> {
        // No pty here on purpose: a pty echoes back whatever is written to the
        // channel before the remote shell executes it, which would otherwise be
        // mistaken for the command's actual output. `exec cat` keeps the process
        // (and therefore the channel's agent-forwarding socket) alive indefinitely
        // after printing the socket path once.
        return this.sshConnection!.execChannel('echo "$SSH_AUTH_SOCK"; exec cat').then(channel => {
            this.agentForwardSession?.close();
            this.agentForwardSession = channel;

            return new Promise<string | undefined>(resolve => {
                let buffer = '';
                let resolved = false;

                const finish = (value: string | undefined) => {
                    if (!resolved) {
                        resolved = true;
                        channel.removeListener('data', onData);
                        channel.removeListener('close', onClose);
                        clearTimeout(timer);
                        resolve(value);
                    }
                };

                const onData = (data: Buffer) => {
                    buffer += data.toString();
                    const newlineIdx = buffer.indexOf('\n');
                    if (newlineIdx < 0) {
                        return;
                    }
                    // A forwarded SSH_AUTH_SOCK is always an absolute path. Anything else
                    // (e.g. a non-POSIX remote echoing the command back verbatim) is rejected
                    // rather than exported as a bogus value.
                    const value = buffer.slice(0, newlineIdx).trim();
                    finish(value.startsWith('/') ? value : undefined);
                };

                // On a non-POSIX remote the `echo`d line ends the command and the channel
                // closes without a usable path; resolve now instead of waiting for the timeout.
                const onClose = () => finish(undefined);

                const timer = setTimeout(() => {
                    this.logger.trace('Timed out waiting for remote SSH_AUTH_SOCK');
                    finish(undefined);
                }, 5000);

                channel.on('data', onData);
                channel.on('close', onClose);
            });
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort);
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.sshConnection?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    private getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[]) {
        let passwordRetryCount = PASSWORD_RETRY_COUNT;
        let keyboardRetryCount = PASSWORD_RETRY_COUNT;
        identityKeys = identityKeys.slice();
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
            if (methodsLeft === null) {
                this.logger.info(`Trying no-auth authentication`);

                return callback({
                    type: 'none',
                    username: sshUser,
                });
            }
            if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
                const identityKey = identityKeys.shift()!;

                if (identityKey.parsedKey) {
                    this.logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

                    if (identityKey.agentSupport) {
                        const { parsedKey } = identityKey;

                        return callback({
                            type: 'agent',
                            username: sshUser,
                            agent: new class extends ssh2.OpenSSHAgent {
                                // Only return the current key
                                override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                    callback(undefined, [parsedKey]);
                                }
                            }(this.sshAgentSock!)
                        });
                    }
                    if (identityKey.isPrivate) {
                        return callback({
                            type: 'publickey',
                            username: sshUser,
                            key: identityKey.parsedKey
                        });
                    }
                }

                if (!await fileExists(identityKey.filename)) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const keyBuffer = await fs.promises.readFile(identityKey.filename);
                let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                if (result instanceof Error && result.message.includes('but no passphrase given')) {
                    let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                    while (result instanceof Error && passphraseRetryCount > 0) {
                        const passphrase = await vscode.window.showInputBox({
                            title: `Enter passphrase for ${identityKey.filename}`,
                            password: true,
                            ignoreFocusOut: true
                        });
                        if (!passphrase) {
                            break;
                        }
                        result = ssh2.utils.parseKey(keyBuffer, passphrase);
                        passphraseRetryCount--;
                    }
                }
                if (!result || result instanceof Error) {
                    // Try next identity file
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return callback(null as any);
                }

                const key = Array.isArray(result) ? result[0] : result;
                return callback({
                    type: 'publickey',
                    username: sshUser,
                    key
                });
            }
            if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
                if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying password authentication`);
                }

                const password = await vscode.window.showInputBox({
                    title: `Enter password for ${sshUser}@${sshHostName}`,
                    password: true,
                    ignoreFocusOut: true
                });
                passwordRetryCount--;

                return callback(password
                    ? {
                        type: 'password',
                        username: sshUser,
                        password
                    }
                    : false);
            }
            if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
                if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                    this.logger.info(`Trying keyboard-interactive authentication`);
                }

                return callback({
                    type: 'keyboard-interactive',
                    username: sshUser,
                    prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                        const responses: string[] = [];
                        for (const prompt of prompts) {
                            const response = await vscode.window.showInputBox({
                                title: `(${sshUser}@${sshHostName}) ${prompt.prompt}`,
                                password: !prompt.echo,
                                ignoreFocusOut: true
                            });
                            if (response === undefined) {
                                keyboardRetryCount = 0;
                                break;
                            }
                            responses.push(response);
                        }
                        keyboardRetryCount--;
                        finish(responses);
                    }
                });
            }

            callback(false);
        };
    }

    dispose() {
        this.activeHost = undefined;
        disposeAll(this.tunnels);
        this.agentForwardSession?.close();
        this.agentForwardSession = undefined;
        // If there's proxy connections then just close the parent connection
        if (this.proxyConnections.length) {
            this.proxyConnections[0].close();
        } else {
            this.sshConnection?.close();
        }
        this.proxyCommandProcess?.kill();
        this.labelFormatterDisposable?.dispose();
    }
}
