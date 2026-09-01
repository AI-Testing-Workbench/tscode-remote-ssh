import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import {
    AdminContainerListResponse,
    AdminContainerResponse,
    AdminCreateContainerRequest,
    AdminCheckRequest,
    AdminCheckResponse,
    ContainerIdsResponse,
    ContainerLimitRequest,
    ContainerLimitResponse,
    ContainerStatusResponse,
    CreateContainerRequest,
    CreateContainerResponse,
    DefaultImageResponse,
    ExpirationRequest,
    ExpirationResponse,
    ErrorResponse,
    ImageDeleteRequest,
    ImageListResponse,
    ImageReferenceRequest,
    UploadImageInput,
    UserContainerQuery,
    UserIdRequest,
    UserIdsResponse,
    UserMutationResponse,
} from './models';

export const DEFAULT_REST_TIMEOUT_MS = 15_000;

export const REST_ERROR_CODES = {
    API_URL_MISSING: 'api_url_missing',
    INVALID_API_URL: 'invalid_api_url',
    NETWORK: 'network_error',
    HTTP: 'http_error',
    INVALID_RESPONSE: 'invalid_response',
    REQUEST: 'request_error',
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

export interface RestHttpRequest {
    method: 'GET' | 'POST';
    url: URL;
    headers: Record<string, string>;
    body?: Uint8Array;
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
}

export interface UserRestApi {
    createContainer(request: CreateContainerRequest): Promise<CreateContainerResponse>;
    getContainerIds(query: UserContainerQuery): Promise<ContainerIdsResponse>;
    getContainer(containerId: string): Promise<ContainerStatusResponse>;
    checkAdmin(request: AdminCheckRequest): Promise<AdminCheckResponse>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
}

export interface AdminRestApi {
    uploadImage(input: UploadImageInput): Promise<void>;
    pushImage(request: ImageReferenceRequest): Promise<void>;
    listImages(): Promise<ImageListResponse>;
    deleteImage(request: ImageDeleteRequest): Promise<void>;
    getDefaultImage(): Promise<DefaultImageResponse>;
    setDefaultImage(request: ImageReferenceRequest): Promise<void>;
    unsetDefaultImage(): Promise<void>;
    createContainer(request: AdminCreateContainerRequest): Promise<AdminContainerResponse>;
    listContainers(): Promise<AdminContainerListResponse>;
    getContainer(containerId: string): Promise<AdminContainerResponse>;
    startContainer(containerId: string): Promise<void>;
    stopContainer(containerId: string): Promise<void>;
    restartContainer(containerId: string): Promise<void>;
    deleteContainer(containerId: string): Promise<void>;
    permanentDeleteContainer(containerId: string): Promise<void>;
    setExpiration(containerId: string, request: ExpirationRequest): Promise<ExpirationResponse>;
    restoreContainer(containerId: string, request: ExpirationRequest): Promise<void>;
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
    headers?: Record<string, string>;
}

interface MultipartBody {
    body: Uint8Array;
    contentType: string;
}

export function normalizeBackendApiUrl(value: string | undefined): string {
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

export function buildMultipartBody(input: UploadImageInput): MultipartBody {
    if (!input.filename || /[\r\n]/.test(input.filename)) {
        throw new RestClientError(
            'request',
            REST_ERROR_CODES.REQUEST,
            '镜像文件名无效',
        );
    }

    const boundary = `----TestAgentRemote${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const appendField = (name: string, value: string): void => {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'utf8',
        ));
    };

    if (input.registry !== undefined && input.registry !== null) {
        appendField('registry', input.registry);
    }
    if (input.namespace !== undefined && input.namespace !== null) {
        appendField('namespace', input.namespace);
    }
    if (input.auto_push !== undefined) {
        appendField('auto_push', String(input.auto_push));
    }

    const escapedFilename = input.filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapedFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
    ));
    parts.push(Buffer.from(input.file));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

export class RestClient {
    public readonly user: UserRestApi;
    public readonly admin: AdminRestApi;

    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly transport: RestHttpTransport;

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

        this.user = {
            createContainer: request => this.requestJson<CreateContainerResponse>('POST', '/user/containers', { jsonBody: request }),
            getContainerIds: query => this.requestJson<ContainerIdsResponse>('GET', '/user/containers', { query }),
            getContainer: containerId => this.requestJson<ContainerStatusResponse>('GET', this.containerPath('/user/containers', containerId)),
            checkAdmin: request => this.requestJson<AdminCheckResponse>('POST', '/user/check', { jsonBody: request }),
            startContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'start')),
            stopContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'stop')),
            restartContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'restart')),
            deleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/user/containers', containerId, 'delete')),
        };

        this.admin = {
            uploadImage: input => this.uploadImage(input),
            pushImage: request => this.requestNoContent('POST', '/admin/images/push', { jsonBody: request }),
            listImages: () => this.requestJson<ImageListResponse>('GET', '/admin/images'),
            deleteImage: request => this.requestNoContent('POST', '/admin/images/delete', { jsonBody: request }),
            getDefaultImage: () => this.requestJson<DefaultImageResponse>('GET', '/admin/images/default'),
            setDefaultImage: request => this.requestNoContent('POST', '/admin/images/default', { jsonBody: request }),
            unsetDefaultImage: () => this.requestNoContent('POST', '/admin/images/default/unset'),
            createContainer: request => this.requestJson<AdminContainerResponse>('POST', '/admin/containers', { jsonBody: request }),
            listContainers: () => this.requestJson<AdminContainerListResponse>('GET', '/admin/containers'),
            getContainer: containerId => this.requestJson<AdminContainerResponse>('GET', this.containerPath('/admin/containers', containerId)),
            startContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'start')),
            stopContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'stop')),
            restartContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'restart')),
            deleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'delete')),
            permanentDeleteContainer: containerId => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'permanent-delete')),
            setExpiration: (containerId, request) => this.requestJson<ExpirationResponse>('POST', this.actionPath('/admin/containers', containerId, 'expiration'), { jsonBody: request }),
            restoreContainer: (containerId, request) => this.requestNoContent('POST', this.actionPath('/admin/containers', containerId, 'restore'), { jsonBody: request }),
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

    private async uploadImage(input: UploadImageInput): Promise<void> {
        const multipart = buildMultipartBody(input);
        await this.requestNoContent('POST', '/admin/images/upload', {
            body: multipart.body,
            headers: { 'Content-Type': multipart.contentType },
        });
    }

    private async requestJson<T>(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<T> {
        const response = await this.send(method, path, options);
        if (response === undefined) {
            throw new RestClientError(
                'response',
                REST_ERROR_CODES.INVALID_RESPONSE,
                '后端 REST API 返回空响应',
            );
        }
        return response as T;
    }

    private async requestNoContent(method: 'GET' | 'POST', path: string, options?: RequestOptions): Promise<void> {
        await this.send(method, path, options);
    }

    private async send(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<unknown | undefined> {
        const url = this.buildUrl(path, options.query);
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...options.headers,
        };
        let body = options.body;

        if (options.jsonBody !== undefined) {
            if (body !== undefined) {
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

        if (body !== undefined) {
            headers['Content-Length'] = String(body.byteLength);
        }

        let response: RestHttpResponse;
        try {
            response = await this.transport({ method, url, headers, body, timeoutMs: this.timeoutMs });
        } catch (error) {
            if (error instanceof RestClientError) {
                throw error;
            }
            throw new RestClientError(
                'network',
                REST_ERROR_CODES.NETWORK,
                '后端 REST API 网络请求失败',
                undefined,
                error,
            );
        }

        const bodyText = Buffer.from(response.body).toString('utf8').trim();
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
            throw new RestClientError(
                'http',
                apiError?.code ?? REST_ERROR_CODES.HTTP,
                apiError?.message ?? `后端 REST API 请求失败 (HTTP ${response.statusCode})`,
                response.statusCode,
            );
        }

        if (!bodyText) {
            return undefined;
        }
        if (!hasJsonBody) {
            throw new RestClientError(
                'response',
                REST_ERROR_CODES.INVALID_RESPONSE,
                '后端 REST API 返回了无效的 JSON',
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
                '未配置后端 REST API 地址',
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
                '后端 REST API 地址无效',
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
        nodeRequest.destroy(new Error('request timed out'));
    });
    nodeRequest.on('error', reject);
    if (request.body !== undefined) {
        nodeRequest.write(Buffer.from(request.body));
    }
    nodeRequest.end();
});
