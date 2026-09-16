import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';

const DEFAULT_TICKET_TTL_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROBE_BODY_BYTES = 2 * 1024 * 1024;
const SESSION_COOKIE = 'testagent_filebrowser_session';
const LOCAL_BRIDGE_HOST = 'localhost';

export interface FileBrowserBridgeSession {
    readonly frameUrl: string;
    dispose(): void;
}

export interface FileBrowserBridgeOptions {
    ticketTtlMs?: number;
    sessionTtlMs?: number;
    requestTimeoutMs?: number;
}

export interface FileBrowserProbeOptions {
    timeoutMs?: number;
    proxied?: boolean;
}

export class FileBrowserBridgeError extends Error {
    public constructor(
        message: string,
        public readonly code = 'filebrowser_bridge_error',
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'FileBrowserBridgeError';
    }
}

interface PendingTicket {
    baseUrl: URL;
    jwt: string;
    context: string;
    expiresAt: number;
    onConsumed: (sessionHash: string) => void;
}

interface BridgeSessionRecord {
    baseUrl: URL;
    jwt: string;
    context: string;
    expiresAt: number;
}

interface UpstreamResponse {
    statusCode: number;
    statusMessage?: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

type RequestModule = typeof http | typeof https;

export function validateFileBrowserUrl(value: string): string {
    parseFileBrowserUrl(value);
    return value.trim();
}

export function getFileBrowserFrameSource(value: string): string {
    return parseFileBrowserUrl(value).origin;
}

export async function probeFileBrowserPage(value: string, jwt?: string, options: FileBrowserProbeOptions = {}): Promise<void> {
    const baseUrl = parseFileBrowserUrl(value);
    const response = await requestBuffer(
        buildUpstreamUrl(baseUrl, '/', ''),
        'GET',
        buildUpstreamHeaders(jwt, 'text/html,application/xhtml+xml'),
        options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        MAX_PROBE_BODY_BYTES,
    );
    const unauthenticatedDirectPage = !jwt && response.statusCode === 401;
    if (response.statusCode < 200 || (response.statusCode >= 400 && !unauthenticatedDirectPage)) {
        throw new FileBrowserBridgeError(
            'FileBrowser Quantum 页面无法访问',
            'filebrowser_page_unavailable',
            response.statusCode,
        );
    }
    assertFrameEmbeddingAllowed(response.headers, options.proxied === true);
}

export class FileBrowserBridge {
    private readonly ticketTtlMs: number;
    private readonly sessionTtlMs: number;
    private readonly requestTimeoutMs: number;
    private readonly tickets = new Map<string, PendingTicket>();
    private readonly sessions = new Map<string, BridgeSessionRecord>();
    private readonly sockets = new Set<net.Socket>();
    private server: http.Server | undefined;
    private serverReady: Promise<number> | undefined;
    private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    public constructor(options: FileBrowserBridgeOptions = {}) {
        this.ticketTtlMs = positiveOption(options.ticketTtlMs, DEFAULT_TICKET_TTL_MS);
        this.sessionTtlMs = positiveOption(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
        this.requestTimeoutMs = positiveOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    }

    public async createSession(options: {
        baseUrl: string;
        username: string;
        password: string;
        context: string;
    }): Promise<FileBrowserBridgeSession> {
        if (this.disposed) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录桥接已关闭', 'filebrowser_bridge_closed');
        }
        const baseUrl = parseFileBrowserUrl(options.baseUrl);
        const username = options.username.trim();
        if (!username || !options.password) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录配置不完整', 'filebrowser_credentials_invalid');
        }
        const context = options.context.trim();
        if (!context) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录上下文无效', 'filebrowser_context_invalid');
        }

        const jwt = await this.login(baseUrl, username, options.password);
        await probeFileBrowserPage(baseUrl.toString(), jwt, {
            timeoutMs: this.requestTimeoutMs,
            proxied: true,
        });
        const port = await this.ensureServer();
        const ticket = randomToken();
        const ticketHash = hashToken(ticket);
        let sessionHash: string | undefined;
        const expiresAt = Date.now() + this.sessionTtlMs;
        this.tickets.set(ticketHash, {
            baseUrl,
            jwt,
            context,
            expiresAt: Math.min(expiresAt, Date.now() + this.ticketTtlMs),
            onConsumed: hash => {
                sessionHash = hash;
            },
        });
        this.scheduleCleanup();

        return {
            frameUrl: `http://${LOCAL_BRIDGE_HOST}:${port}/ticket/${ticket}`,
            dispose: () => {
                this.tickets.delete(ticketHash);
                if (sessionHash) {
                    this.sessions.delete(sessionHash);
                }
                this.scheduleCleanup();
                this.closeServerIfIdle();
            },
        };
    }

    public disposeContext(context: string): void {
        const normalizedContext = context.trim();
        for (const [hash, ticket] of this.tickets) {
            if (ticket.context === normalizedContext) {
                this.tickets.delete(hash);
            }
        }
        for (const [hash, session] of this.sessions) {
            if (session.context === normalizedContext) {
                this.sessions.delete(hash);
            }
        }
        this.scheduleCleanup();
        this.closeServerIfIdle();
    }

    public dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.tickets.clear();
        this.sessions.clear();
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        for (const socket of this.sockets) {
            socket.destroy();
        }
        this.sockets.clear();
        const server = this.server;
        this.server = undefined;
        this.serverReady = undefined;
        if (server) {
            server.close();
        }
    }

    private async login(baseUrl: URL, username: string, password: string): Promise<string> {
        let response: UpstreamResponse;
        try {
            response = await requestBuffer(
                buildUpstreamUrl(baseUrl, '/api/auth/login', `username=${encodeURIComponent(username)}`),
                'POST',
                {
                    Accept: 'application/json, text/plain',
                    'Accept-Encoding': 'identity',
                    'X-Password': encodeURIComponent(password),
                },
                this.requestTimeoutMs,
                MAX_PROBE_BODY_BYTES,
            );
        } catch {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录请求失败', 'filebrowser_login_failed');
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录失败', 'filebrowser_login_failed', response.statusCode);
        }
        const jwt = extractJwt(response.body);
        if (!jwt) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录响应无效', 'filebrowser_login_failed', response.statusCode);
        }
        return jwt;
    }

    private async ensureServer(): Promise<number> {
        if (this.disposed) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 登录桥接已关闭', 'filebrowser_bridge_closed');
        }
        if (this.serverReady) {
            return this.serverReady;
        }

        const server = http.createServer((request, response) => {
            void this.handleRequest(request, response);
        });
        server.on('connection', socket => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
        });
        server.on('upgrade', (request, socket, head) => {
            this.handleUpgrade(request, socket, head);
        });
        this.server = server;
        this.serverReady = new Promise<number>((resolve, reject) => {
            server.once('error', () => {
                this.server = undefined;
                this.serverReady = undefined;
                reject(new FileBrowserBridgeError('无法启动 FileBrowser Quantum 本地桥接', 'filebrowser_bridge_start_failed'));
            });
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    this.server = undefined;
                    this.serverReady = undefined;
                    reject(new FileBrowserBridgeError('无法获取 FileBrowser Quantum 本地桥接地址', 'filebrowser_bridge_start_failed'));
                    return;
                }
                resolve(address.port);
            });
        });
        return this.serverReady;
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        this.cleanupExpired();
        if (this.disposed) {
            respondError(response, 410, 'FileBrowser Quantum 登录桥接已关闭');
            return;
        }
        const parsed = parseLocalRequestUrl(request.url);
        if (!parsed) {
            respondError(response, 400, 'FileBrowser Quantum 请求地址无效');
            return;
        }
        const ticketMatch = /^\/ticket\/([^/]+)$/.exec(parsed.pathname);
        if (ticketMatch) {
            await this.handleTicket(request, response, ticketMatch[1]);
            return;
        }
        if (parsed.pathname.startsWith('/ticket/')) {
            respondError(response, 404, 'FileBrowser Quantum 登录票据无效');
            return;
        }
        const session = this.findSession(request.headers.cookie);
        if (!session) {
            respondError(response, 401, 'FileBrowser Quantum 登录会话已失效');
            return;
        }
        if (!isProxyPathSafe(parsed.pathname)) {
            respondError(response, 400, 'FileBrowser Quantum 请求地址无效');
            return;
        }
        await this.proxyRequest(request, response, parsed, session);
    }

    private async handleTicket(request: IncomingMessage, response: ServerResponse, ticket: string): Promise<void> {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            respondError(response, 405, 'FileBrowser Quantum 登录票据只支持页面请求');
            return;
        }
        const ticketHash = hashToken(ticket);
        const pending = this.tickets.get(ticketHash);
        if (!pending || pending.expiresAt <= Date.now()) {
            this.tickets.delete(ticketHash);
            respondError(response, 404, 'FileBrowser Quantum 登录票据无效');
            this.closeServerIfIdle();
            return;
        }
        this.tickets.delete(ticketHash);
        const sessionToken = randomToken();
        const sessionHash = hashToken(sessionToken);
        this.sessions.set(sessionHash, {
            baseUrl: pending.baseUrl,
            jwt: pending.jwt,
            context: pending.context,
            expiresAt: Date.now() + this.sessionTtlMs,
        });
        pending.onConsumed(sessionHash);
        this.scheduleCleanup();
        response.writeHead(303, {
            Location: '/',
            'Set-Cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${Math.ceil(this.sessionTtlMs / 1000)}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        });
        response.end();
    }

    private findSession(cookieHeader: string | undefined): BridgeSessionRecord | undefined {
        const token = readCookie(cookieHeader, SESSION_COOKIE);
        if (!token) {
            return undefined;
        }
        const hash = hashToken(token);
        const session = this.sessions.get(hash);
        if (!session || session.expiresAt <= Date.now()) {
            this.sessions.delete(hash);
            this.closeServerIfIdle();
            return undefined;
        }
        return session;
    }

    private async proxyRequest(
        request: IncomingMessage,
        response: ServerResponse,
        parsed: URL,
        session: BridgeSessionRecord,
    ): Promise<void> {
        const method = request.method ?? 'GET';
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
            respondError(response, 405, 'FileBrowser Quantum 请求方法不受支持');
            return;
        }
        const target = buildUpstreamUrl(session.baseUrl, parsed.pathname, parsed.search.replace(/^\?/, ''));
        const headers = buildProxyRequestHeaders(request.headers, session.jwt);
        const requestModule = getRequestModule(target);

        await new Promise<void>(resolve => {
            const upstreamRequest = requestModule.request(target, {
                method,
                headers,
            }, upstreamResponse => {
                void this.pipeProxyResponse(upstreamResponse, response, session, method, resolve);
            });
            upstreamRequest.setTimeout(this.requestTimeoutMs, () => {
                upstreamRequest.destroy();
                if (!response.headersSent) {
                    respondError(response, 504, 'FileBrowser Quantum 页面请求超时');
                }
                resolve();
            });
            upstreamRequest.on('error', () => {
                if (!response.headersSent) {
                    respondError(response, 502, 'FileBrowser Quantum 页面无法加载');
                } else {
                    response.destroy();
                }
                resolve();
            });
            request.on('aborted', () => upstreamRequest.destroy());
            request.pipe(upstreamRequest);
        });
    }

    private async pipeProxyResponse(
        upstreamResponse: IncomingMessage,
        response: ServerResponse,
        session: BridgeSessionRecord,
        method: string,
        resolve: () => void,
    ): Promise<void> {
        if (upstreamResponse.statusCode === 401) {
            this.removeSession(session);
        }
        const headers = copyResponseHeaders(upstreamResponse.headers, session.baseUrl);
        const contentType = headerValue(upstreamResponse.headers, 'content-type');
        const shouldRewrite = Boolean(contentType?.toLowerCase().includes('text/html'))
            && !headerValue(upstreamResponse.headers, 'content-encoding');
        if (!shouldRewrite) {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
            upstreamResponse.pipe(response);
            upstreamResponse.once('end', resolve);
            upstreamResponse.once('error', () => {
                response.destroy();
                resolve();
            });
            return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        upstreamResponse.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.byteLength;
            if (size <= MAX_PROBE_BODY_BYTES) {
                chunks.push(buffer);
            }
        });
        upstreamResponse.once('error', () => {
            if (!response.headersSent) {
                respondError(response, 502, 'FileBrowser Quantum 页面无法加载');
            } else {
                response.destroy();
            }
            resolve();
        });
        upstreamResponse.once('end', () => {
            if (size > MAX_PROBE_BODY_BYTES) {
                respondError(response, 502, 'FileBrowser Quantum 页面响应过大');
                resolve();
                return;
            }
            const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString('utf8'), session.baseUrl), 'utf8');
            headers['content-length'] = String(body.byteLength);
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
            if (method !== 'HEAD') {
                response.end(body);
            } else {
                response.end();
            }
            resolve();
        });
    }

    private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
        this.cleanupExpired();
        if (this.disposed || !isSocket(socket)) {
            socket.destroy();
            return;
        }
        const parsed = parseLocalRequestUrl(request.url);
        const session = parsed && isProxyPathSafe(parsed.pathname) ? this.findSession(request.headers.cookie) : undefined;
        if (!parsed || !session) {
            rejectUpgrade(socket, 401, 'FileBrowser Quantum 登录会话已失效');
            return;
        }
        const target = buildUpstreamUrl(session.baseUrl, parsed.pathname, parsed.search.replace(/^\?/, ''));
        const requestModule = getRequestModule(target);
        const upstreamRequest = requestModule.request(target, {
            method: 'GET',
            headers: buildWebSocketHeaders(request.headers, session.jwt),
        });
        let completed = false;
        const finish = (): void => {
            if (completed) {
                return;
            }
            completed = true;
            socket.destroy();
        };
        upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
            if (upstreamResponse.statusCode === 401) {
                this.removeSession(session);
            }
            const responseHeaders = Object.entries(upstreamResponse.headers)
                .filter(([name]) => !['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie'].includes(name))
                .flatMap(([name, value]) => Array.isArray(value) ? value.map(item => `${name}: ${item}`) : value ? [`${name}: ${value}`] : [])
                .join('\r\n');
            socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? ''}\r\n${responseHeaders}\r\n\r\n`);
            if (head.length) {
                upstreamSocket.write(head);
            }
            if (upstreamHead.length) {
                upstreamSocket.unshift(upstreamHead);
            }
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
            upstreamSocket.once('close', finish);
            socket.once('close', () => upstreamSocket.destroy());
        });
        upstreamRequest.once('response', response => {
            response.resume();
            rejectUpgrade(socket, response.statusCode ?? 502, 'FileBrowser Quantum WebSocket 请求失败');
            finish();
        });
        upstreamRequest.once('error', () => finish());
        upstreamRequest.setTimeout(this.requestTimeoutMs, () => {
            upstreamRequest.destroy();
            finish();
        });
        upstreamRequest.end();
    }

    private removeSession(session: BridgeSessionRecord): void {
        for (const [hash, value] of this.sessions) {
            if (value === session) {
                this.sessions.delete(hash);
            }
        }
        this.scheduleCleanup();
        this.closeServerIfIdle();
    }

    private cleanupExpired(): void {
        const now = Date.now();
        for (const [hash, ticket] of this.tickets) {
            if (ticket.expiresAt <= now) {
                this.tickets.delete(hash);
            }
        }
        for (const [hash, session] of this.sessions) {
            if (session.expiresAt <= now) {
                this.sessions.delete(hash);
            }
        }
        this.closeServerIfIdle();
    }

    private scheduleCleanup(): void {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        const expirations = [
            ...Array.from(this.tickets.values(), ticket => ticket.expiresAt),
            ...Array.from(this.sessions.values(), session => session.expiresAt),
        ];
        if (!expirations.length || this.disposed) {
            return;
        }
        const delay = Math.max(1, Math.min(...expirations) - Date.now());
        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = undefined;
            this.cleanupExpired();
            this.scheduleCleanup();
        }, delay);
    }

    private closeServerIfIdle(): void {
        if (this.tickets.size || this.sessions.size || !this.server) {
            return;
        }
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        const server = this.server;
        this.server = undefined;
        this.serverReady = undefined;
        server.close();
    }
}

function parseFileBrowserUrl(value: string): URL {
    if (typeof value !== 'string' || !value.trim() || hasControlCharacters(value)) {
        throw new FileBrowserBridgeError('FileBrowser Quantum 地址无效', 'filebrowser_url_invalid');
    }
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new FileBrowserBridgeError('FileBrowser Quantum 地址无效', 'filebrowser_url_invalid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new FileBrowserBridgeError('FileBrowser Quantum 地址无效', 'filebrowser_url_invalid');
    }
    return url;
}

function buildUpstreamUrl(baseUrl: URL, path: string, search: string): URL {
    const target = new URL(baseUrl.toString());
    const prefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '');
    const suffix = path === '/' ? '/' : `/${path.replace(/^\/+/, '')}`;
    target.pathname = `${prefix}${suffix}` || '/';
    target.search = search ? `?${search.replace(/^\?/, '')}` : '';
    target.hash = '';
    return target;
}

function buildUpstreamHeaders(jwt: string | undefined, accept: string): Record<string, string> {
    return {
        Accept: accept,
        'Accept-Encoding': 'identity',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    };
}

function buildProxyRequestHeaders(headers: IncomingHttpHeaders, jwt: string): Record<string, string> {
    const result = copyRequestHeaders(headers, false);
    result.Authorization = `Bearer ${jwt}`;
    result['Accept-Encoding'] = 'identity';
    return result;
}

function buildWebSocketHeaders(headers: IncomingHttpHeaders, jwt: string): Record<string, string> {
    const result = copyRequestHeaders(headers, true);
    result.Connection = 'Upgrade';
    result.Upgrade = 'websocket';
    result.Authorization = `Bearer ${jwt}`;
    return result;
}

function copyRequestHeaders(headers: IncomingHttpHeaders, websocket: boolean): Record<string, string> {
    const result: Record<string, string> = {};
    const blocked = new Set([
        'host',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'cookie',
        'authorization',
        'x-password',
        'origin',
        'referer',
        'accept-encoding',
    ]);
    for (const [name, value] of Object.entries(headers)) {
        const lowerName = name.toLowerCase();
        if (blocked.has(lowerName) || !value || !websocket && lowerName.startsWith('sec-websocket-')) {
            continue;
        }
        result[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return result;
}

function copyResponseHeaders(headers: IncomingHttpHeaders, baseUrl: URL): Record<string, string> {
    const result: Record<string, string> = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
    };
    const blocked = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'set-cookie',
        'content-length',
    ]);
    for (const [name, value] of Object.entries(headers)) {
        if (blocked.has(name) || !value) {
            continue;
        }
        const normalizedValue = Array.isArray(value) ? value.join(', ') : value;
        result[name] = name === 'location'
            ? rewriteLocation(normalizedValue, baseUrl)
            : normalizedValue;
    }
    return result;
}

function rewriteLocation(value: string, baseUrl: URL): string {
    try {
        const location = new URL(value, baseUrl);
        if (location.origin !== baseUrl.origin) {
            return value;
        }
        const prefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '');
        if (prefix && location.pathname !== prefix && !location.pathname.startsWith(`${prefix}/`)) {
            return value;
        }
        const path = prefix ? location.pathname.slice(prefix.length) || '/' : location.pathname;
        return `${path}${location.search}${location.hash}`;
    } catch {
        return value;
    }
}

function rewriteHtml(value: string, baseUrl: URL): string {
    const prefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '');
    let rewritten = value.split(`${baseUrl.origin}${prefix}`).join('');
    const originPattern = new RegExp(`${escapeRegExp(baseUrl.origin)}(?=\\/)`, 'g');
    rewritten = rewritten.replace(originPattern, '');
    if (prefix) {
        const pathPrefix = `${prefix}/`;
        for (const quote of ['"', '\'']) {
            rewritten = rewritten.split(`${quote}${pathPrefix}`).join(`${quote}/`);
        }
    }
    return rewritten;
}

function assertFrameEmbeddingAllowed(headers: IncomingHttpHeaders, proxied: boolean): void {
    const frameOptions = headerValue(headers, 'x-frame-options')?.toLowerCase().trim();
    if (frameOptions === 'deny' || !proxied && frameOptions === 'sameorigin') {
        throw new FileBrowserBridgeError('FileBrowser Quantum 页面禁止 iframe 嵌入', 'filebrowser_frame_blocked');
    }
    const policy = headerValue(headers, 'content-security-policy');
    const match = policy?.match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i);
    if (!match) {
        return;
    }
    const sources = match[1].trim().split(/\s+/);
    if (sources.includes('\'none\'')) {
        throw new FileBrowserBridgeError('FileBrowser Quantum 页面禁止 iframe 嵌入', 'filebrowser_frame_blocked');
    }
    if (proxied) {
        const hasCompatibleSource = sources.includes('\'self\'') || sources.includes('*');
        if (!hasCompatibleSource) {
            throw new FileBrowserBridgeError('FileBrowser Quantum 页面禁止 iframe 嵌入', 'filebrowser_frame_blocked');
        }
    } else if (sources.length === 1 && sources[0] === '\'self\'') {
        throw new FileBrowserBridgeError('FileBrowser Quantum 页面禁止 iframe 嵌入', 'filebrowser_frame_blocked');
    }
}

function parseLocalRequestUrl(value: string | undefined): URL | undefined {
    if (!value) {
        return undefined;
    }
    try {
        return new URL(value, 'http://127.0.0.1');
    } catch {
        return undefined;
    }
}

function isProxyPathSafe(path: string): boolean {
    if (!path.startsWith('/') || hasControlCharacters(path)) {
        return false;
    }
    return path.split('/').every(segment => {
        try {
            const decoded = decodeURIComponent(segment);
            return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\');
        } catch {
            return false;
        }
    });
}

function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) {
        return undefined;
    }
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== name) {
            continue;
        }
        return part.slice(separator + 1).trim();
    }
    return undefined;
}

function extractJwt(body: Buffer): string | undefined {
    const text = body.toString('utf8').trim();
    if (!text || hasControlCharacters(text)) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'string') {
            return parsed.trim() || undefined;
        }
        if (isRecord(parsed)) {
            for (const key of ['token', 'jwt', 'access_token']) {
                if (typeof parsed[key] === 'string' && parsed[key].trim()) {
                    return parsed[key].trim();
                }
            }
        }
    } catch {
        return text;
    }
    return undefined;
}

function requestBuffer(
    url: URL,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    timeoutMs: number,
    maxBodyBytes: number,
): Promise<UpstreamResponse> {
    return new Promise<UpstreamResponse>((resolve, reject) => {
        const requestModule = getRequestModule(url);
        let settled = false;
        const finish = (callback: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            callback();
        };
        const request = requestModule.request(url, { method, headers }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += buffer.byteLength;
                if (size <= maxBodyBytes) {
                    chunks.push(buffer);
                }
            });
            response.once('end', () => {
                if (size > maxBodyBytes) {
                    finish(() => reject(new FileBrowserBridgeError('FileBrowser 响应过大', 'filebrowser_response_too_large')));
                    return;
                }
                finish(() => resolve({
                    statusCode: response.statusCode ?? 0,
                    statusMessage: response.statusMessage,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                }));
            });
            response.once('error', () => finish(() => reject(new FileBrowserBridgeError('FileBrowser Quantum 响应读取失败', 'filebrowser_response_failed', undefined))));
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy();
            finish(() => reject(new FileBrowserBridgeError('FileBrowser Quantum 请求超时', 'filebrowser_request_timeout')));
        });
        request.once('error', () => finish(() => reject(new FileBrowserBridgeError('FileBrowser Quantum 请求失败', 'filebrowser_request_failed'))));
        request.end();
    });
}

function getRequestModule(url: URL): RequestModule {
    return url.protocol === 'https:' ? https : http;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function respondError(response: ServerResponse, statusCode: number, message: string): void {
    if (response.headersSent) {
        response.destroy();
        return;
    }
    response.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
    });
    response.end(message);
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
    socket.write(`HTTP/1.1 ${statusCode} Error\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`);
    socket.destroy();
}

function isSocket(value: Duplex): value is net.Socket {
    return value instanceof net.Socket;
}

function hashToken(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(): string {
    return randomBytes(32).toString('base64url');
}

function positiveOption(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }
    return false;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
