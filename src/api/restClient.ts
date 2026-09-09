import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import {
    AdminContainerListResponse,
    AdminContainerResponse,
    AdminCreateContainerRequest,
    AdminCheckRequest,
    AdminCheckResponse,
    AdminStateResponse,
    ContainerIdsResponse,
    ContainerLimitRequest,
    ContainerLimitResponse,
    ContainerStatusListResponse,
    ContainerStatusResponse,
    ContainerTypeValue,
    CreateContainerRequest,
    CreateContainerResponse,
    DefaultImageResponse,
    ErrorResponse,
    ExpirationRequest,
    ExpirationResponse,
    ImageDeleteRequest,
    ImageListResponse,
    ImageReferenceRequest,
    OrphanContainerDeleteRequest,
    OrphanContainerListResponse,
    SetDefaultImageRequest,
    UploadImageFileInput,
    UploadImageInput,
    UploadImageRequest,
    UserContainerQuery,
    UserIdRequest,
    UserIdsResponse,
    UserMutationResponse,
} from './models';

export const DEFAULT_REST_TIMEOUT_MS = 15_000;
export const DEFAULT_LIFECYCLE_TIMEOUT_MS = 60_000;
export const DEFAULT_LONG_RUNNING_TIMEOUT_MS = 20 * 60_000;
export const ADMIN_OPERATOR_USER_ID_HEADER = 'X-Operator-User-ID';

export const REST_ERROR_CODES = {
    API_URL_MISSING: 'api_url_missing',
    INVALID_API_URL: 'invalid_api_url',
    NETWORK: 'network_error',
    HTTP: 'http_error',
    INVALID_RESPONSE: 'invalid_response',
    REQUEST: 'request_error',
    TIMEOUT: 'request_timeout',
} as const;

export type RestClientErrorKind = 'configuration' | 'network' | 'http' | 'response' | 'request';

export class RestClientError extends Error {
    constructor(
        public readonly kind: RestClientErrorKind,
        public readonly code: string,
        message: string,
        public readonly statusCode?: number,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'RestClientError';
    }
}

export function formatRestClientError(error: unknown, fallback = 'TestAgent Cloud 服务操作失败'): string {
    if (!(error instanceof RestClientError)) {
        return error instanceof Error && error.message ? error.message : String(error ?? fallback);
    }

    if (error.kind === 'http' || error.kind === 'response') {
        const metadata = formatErrorMetadata(error.code, error.statusCode);
        return `后端 TestAgent Cloud 服务请求失败\n请联系支持团队解决\n${error.message}${metadata ? ` (${metadata})` : ''}`;
    }
    if (error.kind === 'network') {
        const apiError = getApiError(error.cause);
        if (apiError) {
            const metadata = formatErrorMetadata(apiError.code, error.statusCode);
            return `后端 TestAgent Cloud 服务请求失败\n请联系支持团队解决\n错误详情: ${error.message}\n${apiError.message}${metadata ? ` (${metadata})` : ''}`;
        }
        return `后端 TestAgent Cloud 服务请求失败\n请联系支持团队解决\n错误详情: ${error.message}`;
    }
    return error.message || fallback;
}

export interface RestHttpRequest {
    method: 'GET' | 'POST';
    url: URL;
    headers: Record<string, string>;
    body?: Uint8Array;
    bodyStream?: Readable;
    timeoutMs: number;
}

export interface RestHttpResponse {
    statusCode: number;
    statusMessage?: string;
    body: Uint8Array;
}

export type RestHttpTransport = (request: RestHttpRequest) => Promise<RestHttpResponse>;

export interface RestClientOptions {
    baseUrl?: string;
    timeoutMs?: number;
    transport?: RestHttpTransport;
    operatorUserId?: string;
}

export interface UserRestApi {
    createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse>;
    getContainerIds(query: UserContainerQuery): Promise<ContainerIdsResponse>;
    getContainerStatuses(query: UserContainerQuery): Promise<ContainerStatusListResponse>;
    getContainer(containerId: string): Promise<ContainerStatusResponse>;
    checkAdmin(request: AdminCheckRequest): Promise<AdminCheckResponse>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
}

export interface AdminRestApi {
    uploadImage(input: UploadImageRequest): Promise<void>;
    pushImage(request: ImageReferenceRequest): Promise<void>;
    listImages(): Promise<ImageListResponse>;
    checkImagePushStates(): Promise<ImageListResponse>;
    deleteImage(request: ImageDeleteRequest): Promise<void>;
    getDefaultImage(type?: ContainerTypeValue): Promise<DefaultImageResponse>;
    setDefaultImage(request: SetDefaultImageRequest): Promise<void>;
    unsetDefaultImage(type?: ContainerTypeValue): Promise<void>;
    createContainer(request: AdminCreateContainerRequest): Promise<AdminContainerResponse>;
    listContainers(): Promise<AdminContainerListResponse>;
    listOrphanContainers(): Promise<OrphanContainerListResponse>;
    deleteOrphanContainers(request: OrphanContainerDeleteRequest): Promise<void>;
    getContainer(containerId: string): Promise<AdminContainerResponse>;
    getContainerLog(containerId: string): Promise<string>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
    permanentDeleteContainer(containerId: string): Promise<void>;
    setExpiration(containerId: string, request: ExpirationRequest): Promise<ExpirationResponse>;
    restoreContainer(containerId: string, request: ExpirationRequest): Promise<void>;
    getState(): Promise<AdminStateResponse>;
    getContainerLimit(): Promise<ContainerLimitResponse>;
    setContainerLimit(request: ContainerLimitRequest): Promise<ContainerLimitResponse>;
    addWhitelistUser(request: UserIdRequest): Promise<UserMutationResponse>;
    listWhitelistUsers(): Promise<UserIdsResponse>;
    deleteWhitelistUser(request: UserIdRequest): Promise<void>;
    addAdminUser(request: UserIdRequest): Promise<UserMutationResponse>;
    listAdminUsers(): Promise<UserIdsResponse>;
    deleteAdminUser(request: UserIdRequest): Promise<void>;
}

interface RequestOptions {
    query?: UserContainerQuery;
    jsonBody?: unknown;
    body?: Uint8Array;
    bodyStream?: Readable;
    bodyLength?: number;
    headers?: Record<string, string>;
    responseType?: 'json' | 'text';
    timeoutMs?: number;
}

interface MultipartBody {
    body: Uint8Array;
    contentType: string;
}

interface MultipartStreamBody {
    body: Readable;
    contentLength: number;
    contentType: string;
}

export function normalizeBackendApiUrl(value: string | undefined): string {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function buildMultipartBody(input: UploadImageInput): MultipartBody {
    const boundary = `----TestAgentRemote${Math.random().toString(16).slice(2)}`;
    const parts = buildMultipartParts(input, boundary);

    return {
        body: Buffer.concat([parts.prefix, Buffer.from(input.file), parts.suffix]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

async function buildMultipartFileBody(input: UploadImageFileInput): Promise<MultipartStreamBody> {
    validateMultipartFilename(input.filename);

    let fileSize: number;
    try {
        const stats = await fsPromises.stat(input.filePath);
        if (!stats.isFile()) {
            throw new Error('not a file');
        }
        fileSize = stats.size;
    } catch (error) {
        throw new RestClientError(
            'request',
            REST_ERROR_CODES.REQUEST,
            '镜像文件无法读取',
            undefined,
            error,
        );
    }
    if (fileSize === 0) {
        throw new RestClientError(
            'request',
            REST_ERROR_CODES.REQUEST,
            '镜像文件不能为空',
        );
    }

    const boundary = `----TestAgentRemote${Math.random().toString(16).slice(2)}`;
    const parts = buildMultipartParts(input, boundary);
    const body = Readable.from((async function* () {
        yield parts.prefix;
        const file = fs.createReadStream(input.filePath);
        try {
            for await (const chunk of file) {
                yield chunk;
            }
        } finally {
            file.destroy();
        }
        yield parts.suffix;
    })());

    return {
        body,
        contentLength: parts.prefix.byteLength + fileSize + parts.suffix.byteLength,
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

function buildMultipartParts(input: UploadImageInput | UploadImageFileInput, boundary: string): { prefix: Buffer; suffix: Buffer } {
    const parts: Buffer[] = [];
    const appendField = (name: string, value: string): void => {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'utf8',
        ));
    };

    validateMultipartFilename(input.filename);
    if (input.registry !== undefined && input.registry !== null) {
        appendField('registry', input.registry);
    }
    if (input.namespace !== undefined && input.namespace !== null) {
        appendField('namespace', input.namespace);
    }
    appendField('auto_push', String(input.auto_push));

    const escapedFilename = input.filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapedFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
    ));

    return {
        prefix: Buffer.concat(parts),
        suffix: Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    };
}

function validateMultipartFilename(filename: string): void {
    if (!filename || /[\r\n]/.test(filename)) {
        throw new RestClientError(
            'request',
            REST_ERROR_CODES.REQUEST,
            '镜像文件名无效',
        );
    }
}

export class RestClient {
    public readonly user: UserRestApi;
    public readonly admin: AdminRestApi;

    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly transport: RestHttpTransport;
    private readonly operatorUserId: string;

    constructor(baseUrl: string, options?: Omit<RestClientOptions, 'baseUrl'>);
    constructor(options?: RestClientOptions);
    constructor(baseUrlOrOptions: string | RestClientOptions = '', additionalOptions: Omit<RestClientOptions, 'baseUrl'> = {}) {
        const options = typeof baseUrlOrOptions === 'string'
            ? { ...additionalOptions, baseUrl: baseUrlOrOptions }
            : baseUrlOrOptions;

        this.baseUrl = normalizeBackendApiUrl(options.baseUrl);
        this.timeoutMs = typeof options.timeoutMs === 'number'
            && Number.isFinite(options.timeoutMs)
            && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_REST_TIMEOUT_MS;
        this.transport = options.transport ?? requestWithNode;
        this.operatorUserId = options.operatorUserId?.trim() ?? '';

        this.user = {
            createContainer: request => this.requestJson<CreateContainerResponse>('POST', '/user/containers', {
                jsonBody: request,
                timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
            }),
            getContainerIds: query => this.requestJson<ContainerIdsResponse>('GET', '/user/containers', { query }),
            getContainerStatuses: query => this.requestJson<ContainerStatusListResponse>('GET', '/user/containers/status', { query }),
            getContainer: containerId => this.requestJson<ContainerStatusResponse>('GET', this.containerPath('/user/containers', containerId)),
            checkAdmin: request => this.requestJson<AdminCheckResponse>('POST', '/user/check', { jsonBody: request }),
            startContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'start'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            stopContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'stop'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            restartContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'restart'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            deleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'delete'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
        };

        this.admin = {
            uploadImage: input => this.uploadImage(input),
            pushImage: request => this.requestNoContent('POST', '/admin/images/push', { jsonBody: request }),
            listImages: () => this.requestJson<ImageListResponse>('GET', '/admin/images'),
            checkImagePushStates: () => this.requestJson<ImageListResponse>('POST', '/admin/images/check'),
            deleteImage: request => this.requestNoContent('POST', '/admin/images/delete', { jsonBody: request }),
            getDefaultImage: type => this.requestJson<DefaultImageResponse>('GET', this.defaultImagePath(type)),
            setDefaultImage: request => this.requestNoContent('POST', '/admin/images/default', { jsonBody: request }),
            unsetDefaultImage: type => this.requestNoContent('POST', this.unsetDefaultImagePath(type)),
            createContainer: request => this.requestJson<AdminContainerResponse>('POST', '/admin/containers', {
                jsonBody: request,
                timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
            }),
            listContainers: () => this.requestJson<AdminContainerListResponse>('GET', '/admin/containers'),
            listOrphanContainers: () => this.requestJson<OrphanContainerListResponse>('GET', '/admin/containers/orphans'),
            deleteOrphanContainers: request => this.requestNoContent('POST', '/admin/containers/orphans/delete', { jsonBody: request }),
            getContainer: containerId => this.requestJson<AdminContainerResponse>('GET', this.containerPath('/admin/containers', containerId)),
            getContainerLog: containerId => this.requestText('GET', `${this.containerPath('/admin/containers', containerId)}/log`),
            startContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'start'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            stopContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'stop'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            restartContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'restart'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            deleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'delete'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            permanentDeleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'permanent-delete'), { timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            setExpiration: (containerId, request) => this.requestJson<ExpirationResponse>('POST', this.actionPath('/admin/containers', containerId, 'expiration'), { jsonBody: request }),
            restoreContainer: (containerId, request) => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'restore'), { jsonBody: request, timeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS }),
            getState: () => this.requestJson<AdminStateResponse>('GET', '/admin/state'),
            getContainerLimit: () => this.requestJson<ContainerLimitResponse>('GET', '/admin/containers/limit'),
            setContainerLimit: request => this.requestJson<ContainerLimitResponse>('POST', '/admin/containers/limit', { jsonBody: request }),
            addWhitelistUser: request => this.requestJson<UserMutationResponse>('POST', '/admin/whitelist-users', { jsonBody: request }),
            listWhitelistUsers: () => this.requestJson<UserIdsResponse>('GET', '/admin/whitelist-users'),
            deleteWhitelistUser: request => this.requestNoContent('POST', '/admin/whitelist-users/delete', { jsonBody: request }),
            addAdminUser: request => this.requestJson<UserMutationResponse>('POST', '/admin/admin-users', { jsonBody: request }),
            listAdminUsers: () => this.requestJson<UserIdsResponse>('GET', '/admin/admin-users'),
            deleteAdminUser: request => this.requestNoContent('POST', '/admin/admin-users/delete', { jsonBody: request }),
        };
    }

    private async uploadImage(input: UploadImageRequest): Promise<void> {
        if ('filePath' in input) {
            const multipart = await buildMultipartFileBody(input);
            await this.requestNoContent('POST', '/admin/images/upload', {
                bodyStream: multipart.body,
                bodyLength: multipart.contentLength,
                headers: { 'Content-Type': multipart.contentType },
                timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
            });
            return;
        }

        const multipart = buildMultipartBody(input);
        await this.requestNoContent('POST', '/admin/images/upload', {
            body: multipart.body,
            headers: { 'Content-Type': multipart.contentType },
            timeoutMs: DEFAULT_LONG_RUNNING_TIMEOUT_MS,
        });
    }

    private async requestJson<T>(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<T> {
        const response = await this.send(method, path, options);
        if (response === undefined) {
            throw new RestClientError(
                'response',
                REST_ERROR_CODES.INVALID_RESPONSE,
                '后端 TestAgent Cloud 管理服务返回空响应',
            );
        }
        return response as T;
    }

    private async requestNoContent(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<void> {
        await this.send(method, path, options);
    }

    private async requestText(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<string> {
        const response = await this.send(method, path, { ...options, responseType: 'text' });
        if (typeof response !== 'string') {
            throw new RestClientError(
                'response',
                REST_ERROR_CODES.INVALID_RESPONSE,
                '后端 TestAgent Cloud 管理服务返回了无效的文本响应',
            );
        }
        return response;
    }

    private async send(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<unknown | undefined> {
        const url = this.buildUrl(path, options.query);
        const headers: Record<string, string> = {
            Accept: options.responseType === 'text' ? 'text/plain' : 'application/json',
            ...options.headers,
        };
        if (this.operatorUserId && (path === '/admin' || path.startsWith('/admin/'))) {
            headers[ADMIN_OPERATOR_USER_ID_HEADER] = this.operatorUserId;
        }
        let body = options.body;
        const bodyStream = options.bodyStream;

        if (options.jsonBody !== undefined) {
            if (body !== undefined || bodyStream !== undefined) {
                throw new RestClientError(
                    'request',
                    REST_ERROR_CODES.REQUEST,
                    '请求不能同时包含 JSON 和 multipart 内容',
                );
            }

            try {
                body = Buffer.from(JSON.stringify(options.jsonBody), 'utf8');
            } catch (error) {
                throw new RestClientError(
                    'request',
                    REST_ERROR_CODES.REQUEST,
                    '请求体无法序列化',
                    undefined,
                    error,
                );
            }
            headers['Content-Type'] = 'application/json';
        }

        if (body !== undefined && bodyStream !== undefined) {
            throw new RestClientError(
                'request',
                REST_ERROR_CODES.REQUEST,
                '请求不能同时包含内存和流式请求体',
            );
        }
        if (bodyStream !== undefined
            && (!Number.isSafeInteger(options.bodyLength) || (options.bodyLength ?? -1) < 0)) {
            throw new RestClientError(
                'request',
                REST_ERROR_CODES.REQUEST,
                '流式请求缺少有效的请求体长度',
            );
        }

        if (body !== undefined) {
            headers['Content-Length'] = String(body.byteLength);
        } else if (bodyStream !== undefined) {
            headers['Content-Length'] = String(options.bodyLength);
        }

        let response: RestHttpResponse;
        try {
            response = await this.transport({
                method,
                url,
                headers,
                body,
                bodyStream,
                timeoutMs: options.timeoutMs ?? this.timeoutMs,
            });
        } catch (error) {
            if (error instanceof RestClientError) {
                throw error;
            }
            if (isRequestTimeoutError(error)) {
                throw new RestClientError(
                    'network',
                    REST_ERROR_CODES.TIMEOUT,
                    formatTimeoutMessage(path, options.timeoutMs ?? this.timeoutMs),
                    undefined,
                    error,
                );
            }
            throw new RestClientError(
                'network',
                REST_ERROR_CODES.NETWORK,
                '后端 TestAgent Cloud 管理服务请求失败',
                undefined,
                error,
            );
        }

        const rawBodyText = Buffer.from(response.body).toString('utf8');
        const bodyText = rawBodyText.trim();
        let parsedBody: unknown;
        let hasJsonBody = false;
        if (bodyText) {
            try {
                parsedBody = JSON.parse(bodyText) as unknown;
                hasJsonBody = true;
            } catch {
                // A non-JSON body is handled as an HTTP error below, or as an invalid success response.
            }
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            const apiError = getApiError(parsedBody);
            if (response.statusCode === 408 || response.statusCode === 504) {
                throw new RestClientError(
                    'network',
                    REST_ERROR_CODES.TIMEOUT,
                    formatTimeoutMessage(path, options.timeoutMs ?? this.timeoutMs, response.statusCode),
                    response.statusCode,
                    apiError,
                );
            }
            throw new RestClientError(
                'http',
                apiError?.code ?? REST_ERROR_CODES.HTTP,
                apiError?.message ?? `后端 TestAgent Cloud 管理服务请求失败 (HTTP ${response.statusCode})`,
                response.statusCode,
            );
        }

        if (options.responseType === 'text') {
            return rawBodyText;
        }

        if (!bodyText) {
            return undefined;
        }
        if (!hasJsonBody) {
            throw new RestClientError(
                'response',
                REST_ERROR_CODES.INVALID_RESPONSE,
                '后端 TestAgent Cloud 管理服务返回了无效的 JSON',
                response.statusCode,
            );
        }
        return parsedBody;
    }

    private buildUrl(path: string, query?: UserContainerQuery): URL {
        if (!this.baseUrl) {
            throw new RestClientError(
                'configuration',
                REST_ERROR_CODES.API_URL_MISSING,
                '未配置后端 TestAgent Cloud 管理服务的 API 地址',
            );
        }

        let baseUrl: URL;
        try {
            baseUrl = new URL(this.baseUrl);
            if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
                throw new Error('unsupported protocol');
            }
            baseUrl.search = '';
            baseUrl.hash = '';
            if (!baseUrl.pathname.endsWith('/')) {
                baseUrl.pathname += '/';
            }
        } catch (error) {
            throw new RestClientError(
                'configuration',
                REST_ERROR_CODES.INVALID_API_URL,
                '后端 TestAgent Cloud 管理服务的 API 地址无效',
                undefined,
                error,
            );
        }

        const url = new URL(path.replace(/^\/+/, ''), baseUrl);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url;
    }

    private containerPath(prefix: string, containerId: string): string {
        return `${prefix}/${encodeURIComponent(containerId)}`;
    }

    private actionPath(prefix: string, containerId: string, action: string): string {
        return `${this.containerPath(prefix, containerId)}/${action}`;
    }

    private defaultImagePath(type?: ContainerTypeValue): string {
        return type ? `/admin/images/default?type=${encodeURIComponent(type)}` : '/admin/images/default';
    }

    private unsetDefaultImagePath(type?: ContainerTypeValue): string {
        return type ? `/admin/images/default/unset?type=${encodeURIComponent(type)}` : '/admin/images/default/unset';
    }
}

function getApiError(value: unknown): ErrorResponse | undefined {
    if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
        return undefined;
    }
    return {
        code: value.code,
        message: value.message,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

class RequestTimeoutError extends Error {
    public constructor() {
        super('request timed out');
        this.name = 'RequestTimeoutError';
    }
}

const requestWithNode: RestHttpTransport = request => new Promise<RestHttpResponse>((resolve, reject) => {
    const requestModule = request.url.protocol === 'https:' ? https : http;
    const nodeRequest = requestModule.request(request.url, {
        method: request.method,
        headers: request.headers,
        timeout: request.timeoutMs,
    }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
            resolve({
                statusCode: response.statusCode ?? 0,
                statusMessage: response.statusMessage,
                body: Buffer.concat(chunks),
            });
        });
        response.on('error', reject);
    });

    nodeRequest.on('timeout', () => {
        request.bodyStream?.destroy();
        nodeRequest.destroy(new RequestTimeoutError());
    });
    nodeRequest.on('error', error => {
        request.bodyStream?.destroy();
        reject(error);
    });
    if (request.bodyStream !== undefined) {
        request.bodyStream.once('error', error => {
            nodeRequest.destroy(error);
        });
        request.bodyStream.pipe(nodeRequest);
    } else {
        if (request.body !== undefined) {
            nodeRequest.write(Buffer.from(request.body));
        }
        nodeRequest.end();
    }
});

function isRequestTimeoutError(error: unknown): boolean {
    if (error instanceof RequestTimeoutError) {
        return true;
    }
    if (!isRecord(error)) {
        return false;
    }
    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    return code === 'ETIMEDOUT'
        || code === 'ESOCKETTIMEDOUT'
        || code === 'ERR_SOCKET_TIMEOUT'
        || code === 'UND_ERR_CONNECT_TIMEOUT'
        || message.includes('timed out')
        || message.includes('timeout')
        || message.includes('timedout');
}

function formatTimeoutMessage(path: string, timeoutMs: number, statusCode?: number): string {
    const operation = path === '/admin/images/upload'
        ? '上传镜像'
        : isContainerActionPath(path, '/start')
            ? '启动 TestAgent Cloud 服务'
            : isContainerActionPath(path, '/stop')
                ? '停止 TestAgent Cloud 服务'
                : isContainerActionPath(path, '/restart')
                    ? '重启 TestAgent Cloud 服务'
                    : isContainerActionPath(path, '/restore')
                        ? '恢复 TestAgent Cloud 服务'
                        : isContainerActionPath(path, '/delete') || isContainerActionPath(path, '/permanent-delete')
                            ? '删除 TestAgent Cloud 服务'
                            : '后端 TestAgent Cloud 管理服务请求';
    const duration = formatTimeoutDuration(timeoutMs);
    const responseDetail = statusCode
        ? `，HTTP 状态码 ${statusCode}，仍未收到响应`
        : '仍未收到响应';
    return `${operation}超时 (已等待 ${duration}${responseDetail})，正在重试中...`;
}

function isContainerActionPath(path: string, suffix: string): boolean {
    return path.includes('/containers/') && path.endsWith(suffix);
}

function formatTimeoutDuration(timeoutMs: number): string {
    const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
    if (seconds % 60 === 0) {
        return `${seconds / 60} 分钟`;
    }
    return `${seconds} 秒`;
}

function formatErrorMetadata(code: string | undefined, statusCode: number | undefined): string {
    return [
        code ? `错误码: ${code}` : '',
        statusCode ? `HTTP 状态码 ${statusCode}` : '',
    ].filter(Boolean).join('，');
}
