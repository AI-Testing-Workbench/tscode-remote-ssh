import * as http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ADMIN_OPERATOR_USER_ID_HEADER,
    buildMultipartBody,
    DEFAULT_LIFECYCLE_TIMEOUT_MS,
    DEFAULT_LONG_RUNNING_TIMEOUT_MS,
    DEFAULT_REST_TIMEOUT_MS,
    formatRestClientError,
    REST_ERROR_CODES,
    RestClient,
    RestClientError,
    RestHttpRequest,
    RestHttpResponse,
} from '../src/api/restClient';

function jsonResponse(statusCode: number, value: unknown): RestHttpResponse {
    return {
        statusCode,
        body: Buffer.from(JSON.stringify(value), 'utf8'),
    };
}

function createTransport(response: RestHttpResponse | Error) {
    const requests: RestHttpRequest[] = [];
    const transport = vi.fn(async (request: RestHttpRequest): Promise<RestHttpResponse> => {
        requests.push(request);
        if (response instanceof Error) {
            throw response;
        }
        return response;
    });
    return { requests, transport };
}

describe('RestClient', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('uses the OpenAPI paths and separates user and admin APIs', async () => {
        const { requests, transport } = createTransport(jsonResponse(200, {}));
        const client = new RestClient('https://api.example.test/v1///', { transport, operatorUserId: 'admin-1' });

        await client.user.createContainer({ user_id: 'user-1' });
        await client.user.getContainerIds({
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
        });
        await client.user.getContainer('container/1');
        await client.user.checkAdmin({ user_id: 'user-1' });
        await client.user.startContainer('container/1');
        await client.user.stopContainer('container/1');
        await client.user.restartContainer('container/1');
        await client.user.deleteContainer('container/1');

        await client.admin.uploadImage({ file: Buffer.from('tar'), filename: 'image.tar', auto_push: true });
        await client.admin.pushImage({ full_name: 'registry/ns/app:v1' });
        await client.admin.listImages();
        await client.admin.deleteImage({ full_name: 'registry/ns/app:v1', also_registry: false });
        await client.admin.getDefaultImage();
        await client.admin.setDefaultImage({ full_name: 'registry/ns/app:v1' });
        await client.admin.unsetDefaultImage();
        await client.admin.createContainer({ user_id: 'user-1' });
        await client.admin.listContainers();
        await client.admin.listOrphanContainers();
        await client.admin.deleteOrphanContainers({ container_ids: ['orphan-1'] });
        await client.admin.getContainer('container/1');
        await client.admin.getContainerLog('container/1');
        await client.admin.startContainer('container/1');
        await client.admin.stopContainer('container/1');
        await client.admin.restartContainer('container/1');
        await client.admin.deleteContainer('container/1');
        await client.admin.permanentDeleteContainer('container/1');
        await client.admin.setExpiration('container/1', { expiration_hours: 1 });
        await client.admin.restoreContainer('container/1', { expiration_hours: 1 });
        await client.admin.getState();
        await client.admin.getContainerLimit();
        await client.admin.setContainerLimit({ container_limit: 3, cpu: 1, memory: 1 });
        await client.admin.addWhitelistUser({ user_id: 'user-1' });
        await client.admin.listWhitelistUsers();
        await client.admin.deleteWhitelistUser({ user_id: 'user-1' });
        await client.admin.addAdminUser({ user_id: 'user-1' });
        await client.admin.listAdminUsers();
        await client.admin.deleteAdminUser({ user_id: 'user-1' });

        expect(requests.map(request => `${request.method} ${request.url.pathname}`)).toEqual([
            'POST /v1/user/containers',
            'GET /v1/user/containers',
            'GET /v1/user/containers/container%2F1',
            'POST /v1/user/check',
            'POST /v1/user/containers/container%2F1/start',
            'POST /v1/user/containers/container%2F1/stop',
            'POST /v1/user/containers/container%2F1/restart',
            'POST /v1/user/containers/container%2F1/delete',
            'POST /v1/admin/images/upload',
            'POST /v1/admin/images/push',
            'GET /v1/admin/images',
            'POST /v1/admin/images/delete',
            'GET /v1/admin/images/default',
            'POST /v1/admin/images/default',
            'POST /v1/admin/images/default/unset',
            'POST /v1/admin/containers',
            'GET /v1/admin/containers',
            'GET /v1/admin/containers/orphans',
            'POST /v1/admin/containers/orphans/delete',
            'GET /v1/admin/containers/container%2F1',
            'GET /v1/admin/containers/container%2F1/log',
            'POST /v1/admin/containers/container%2F1/start',
            'POST /v1/admin/containers/container%2F1/stop',
            'POST /v1/admin/containers/container%2F1/restart',
            'POST /v1/admin/containers/container%2F1/delete',
            'POST /v1/admin/containers/container%2F1/permanent-delete',
            'POST /v1/admin/containers/container%2F1/expiration',
            'POST /v1/admin/containers/container%2F1/restore',
            'GET /v1/admin/state',
            'GET /v1/admin/containers/limit',
            'POST /v1/admin/containers/limit',
            'POST /v1/admin/whitelist-users',
            'GET /v1/admin/whitelist-users',
            'POST /v1/admin/whitelist-users/delete',
            'POST /v1/admin/admin-users',
            'GET /v1/admin/admin-users',
            'POST /v1/admin/admin-users/delete',
        ]);

        expect(requests[1].url.search).toBe('?user_id=user-1&gitee_user=alice&gitee_repository=repo&gitee_branch=main');
        expect(Buffer.from(requests[0].body ?? '').toString('utf8')).toBe('{"user_id":"user-1"}');
        expect(Buffer.from(requests[3].body ?? '').toString('utf8')).toBe('{"user_id":"user-1"}');
        expect(requests.slice(0, 8).every(request => request.headers[ADMIN_OPERATOR_USER_ID_HEADER] === undefined)).toBe(true);
        expect(requests.slice(8).every(request => request.headers[ADMIN_OPERATOR_USER_ID_HEADER] === 'admin-1')).toBe(true);
        const multipartBody = Buffer.from(requests[8].body ?? '').toString('utf8');
        expect(requests[8].headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(requests[0].timeoutMs).toBe(DEFAULT_LONG_RUNNING_TIMEOUT_MS);
        expect(requests[8].timeoutMs).toBe(DEFAULT_LONG_RUNNING_TIMEOUT_MS);
        expect(requests[9].timeoutMs).toBe(DEFAULT_REST_TIMEOUT_MS);
        expect(requests[15].timeoutMs).toBe(DEFAULT_LONG_RUNNING_TIMEOUT_MS);
        expect(requests[4].timeoutMs).toBe(DEFAULT_LIFECYCLE_TIMEOUT_MS);
        expect(requests[5].timeoutMs).toBe(DEFAULT_LIFECYCLE_TIMEOUT_MS);
        expect(requests[21].timeoutMs).toBe(DEFAULT_LIFECYCLE_TIMEOUT_MS);
        expect(requests[25].timeoutMs).toBe(DEFAULT_LIFECYCLE_TIMEOUT_MS);
        expect(requests[27].timeoutMs).toBe(DEFAULT_LIFECYCLE_TIMEOUT_MS);
        expect(multipartBody).toContain('name="auto_push"');
        expect(multipartBody).toContain('name="file"; filename="image.tar"');
        expect(multipartBody).toContain('tar');
    });

    it('explicitly serializes false when automatic pushing is disabled', () => {
        const multipart = buildMultipartBody({
            file: Buffer.from('tar'),
            filename: 'image.tar',
            auto_push: false,
        });
        const body = Buffer.from(multipart.body).toString('utf8');

        expect(body).toMatch(/name="auto_push"\r\n\r\nfalse\r\n/);
    });

    it('streams path-based image uploads instead of buffering the multipart body', async () => {
        const { requests, transport } = createTransport({ statusCode: 204, body: Buffer.alloc(0) });
        const client = new RestClient('https://api.example.test', { transport });

        await client.admin.uploadImage({
            filePath: __filename,
            filename: 'image.tar',
            auto_push: false,
        });

        const request = requests[0];
        expect(request.body).toBeUndefined();
        expect(request.bodyStream).toBeDefined();
        const bodyStream = request.bodyStream;
        if (!bodyStream) {
            throw new Error('expected a multipart body stream');
        }
        const chunks: Buffer[] = [];
        for await (const chunk of bodyStream) {
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);

        expect(request.headers['Content-Length']).toBe(String(body.byteLength));
        expect(body.toString('utf8')).toContain('name="auto_push"\r\n\r\nfalse\r\n');
        expect(body.toString('utf8')).toContain('name="file"; filename="image.tar"');
    });

    it('sends JSON requests through the default Node transport', async () => {
        let requestMethod = '';
        let requestPath = '';
        const server = http.createServer((request, response) => {
            requestMethod = request.method ?? '';
            requestPath = request.url ?? '';
            request.resume();
            request.on('end', () => {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    container_id: 'container-1',
                    status: 'running',
                    endpoint: '10.0.0.1:22',
                    gitee_user: '',
                    gitee_repository: '',
                }));
            });
        });
        const port = await listen(server);

        try {
            const client = new RestClient(`http://127.0.0.1:${port}`);

            await expect(client.user.getContainer('container-1')).resolves.toMatchObject({
                container_id: 'container-1',
                status: 'running',
            });
            expect(requestMethod).toBe('GET');
            expect(requestPath).toBe('/user/containers/container-1');
        } finally {
            await close(server);
        }
    });

    it('sends path-based multipart uploads through the default Node transport', async () => {
        let requestHeaders: http.IncomingHttpHeaders | undefined;
        const receivedChunks: Buffer[] = [];
        const server = http.createServer((request, response) => {
            requestHeaders = request.headers;
            request.on('data', chunk => receivedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            request.on('end', () => {
                response.writeHead(204);
                response.end();
            });
        });
        const port = await listen(server);

        try {
            const client = new RestClient(`http://127.0.0.1:${port}`);

            await client.admin.uploadImage({
                filePath: __filename,
                filename: 'image.tar',
                auto_push: false,
            });

            const body = Buffer.concat(receivedChunks).toString('utf8');
            expect(requestHeaders?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
            expect(requestHeaders?.['content-length']).toBe(String(Buffer.byteLength(body)));
            expect(body).toContain('name="auto_push"\r\n\r\nfalse\r\n');
            expect(body).toContain('name="file"; filename="image.tar"');
        } finally {
            await close(server);
        }
    });

    it('reports long-running upload timeouts separately and explains that the server may still be processing', async () => {
        const timeout = new Error('request timed out');
        const { transport } = createTransport(timeout);
        const client = new RestClient('https://api.example.test', { transport });

        await expect(client.admin.uploadImage({
            file: Buffer.from('tar'),
            filename: 'image.tar',
            auto_push: false,
        })).rejects.toMatchObject({
            code: 'request_timeout',
            message: '上传镜像超时（已等待 20 分钟仍未收到响应），后端可能仍在处理，请稍后检查结果，避免重复提交',
        });
    });

    it('reports timeout responses from the backend clearly for ordinary requests too', async () => {
        const { transport } = createTransport(jsonResponse(504, {
            code: 'backend_timeout',
            message: '服务仍在处理',
        }));
        const client = new RestClient('https://api.example.test', { transport });

        const error = await client.admin.listImages().catch(value => value);
        expect(error).toMatchObject({
            code: 'request_timeout',
            message: '后端 TestAgent Cloud 管理服务请求超时（已等待 15 秒，HTTP 504，仍未收到响应），后端可能仍在处理，请稍后检查结果，避免重复提交',
            statusCode: 504,
            cause: {
                code: 'backend_timeout',
                message: '服务仍在处理',
            },
        });
        expect(formatRestClientError(error)).toBe(
            '后端 TestAgent Cloud 服务请求失败\n'
            + '错误详情：后端 TestAgent Cloud 管理服务请求超时（已等待 15 秒，HTTP 504，仍未收到响应），后端可能仍在处理，请稍后检查结果，避免重复提交\n'
            + '返回错误：服务仍在处理（错误码：backend_timeout，HTTP 504）',
        );
    });

    it('serializes all current user and administrator request fields', async () => {
        const { requests, transport } = createTransport(jsonResponse(200, {}));
        const client = new RestClient('https://api.example.test', { transport, operatorUserId: 'admin-1' });

        await client.user.createContainer({
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            authorize_general_account: true,
        });
        await client.admin.createContainer({
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: null,
            gitee_url: 'https://gitee.com',
            authorize_general_account: false,
            image: 'registry.test:5000/testagent/app:v1',
            expiration_hours: 0,
            cpu: 0.5,
            memory: 1,
        });
        await client.admin.deleteOrphanContainers({ container_ids: ['orphan-1', 'orphan-2'] });
        await client.admin.setExpiration('container-1', { expiration_hours: 0 });
        await client.admin.setContainerLimit({ container_limit: 0, cpu: 0.5, memory: 1 });
        await client.admin.deleteImage({ full_name: 'registry.test:5000/testagent/app:v1', also_registry: false });
        await client.admin.addWhitelistUser({ user_id: 'user-2' });
        await client.admin.addAdminUser({ user_id: 'admin-2' });

        expect(readJsonBody(requests.find(request => request.url.pathname === '/user/containers')!)).toEqual({
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: 'main',
            gitee_url: 'https://gitee.com',
            authorize_general_account: true,
        });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/containers')!)).toEqual({
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: null,
            gitee_url: 'https://gitee.com',
            authorize_general_account: false,
            image: 'registry.test:5000/testagent/app:v1',
            expiration_hours: 0,
            cpu: 0.5,
            memory: 1,
        });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/containers/orphans/delete')!))
            .toEqual({ container_ids: ['orphan-1', 'orphan-2'] });
        expect(readJsonBody(requests.find(request => request.url.pathname.endsWith('/expiration'))!))
            .toEqual({ expiration_hours: 0 });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/containers/limit')!))
            .toEqual({ container_limit: 0, cpu: 0.5, memory: 1 });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/images/delete')!))
            .toEqual({ full_name: 'registry.test:5000/testagent/app:v1', also_registry: false });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/whitelist-users')!))
            .toEqual({ user_id: 'user-2' });
        expect(readJsonBody(requests.find(request => request.url.pathname === '/admin/admin-users')!))
            .toEqual({ user_id: 'admin-2' });
    });

    it('preserves the latest nullable and resource response fields', async () => {
        const userStatus = {
            container_id: 'container-1',
            status: 'running',
            endpoint: null,
            started_at: '2026-09-08T00:00:00Z',
            expires_at: null,
            cpu_usage: 0,
            memory_usage: null,
            gitee_user: 'alice',
            gitee_repository: 'repo',
        };
        const imageList = {
            images: [{
                id: 'image-1',
                full_name: 'registry.test:5000/testagent/app:v1',
                registry: 'registry.test:5000',
                namespace: 'testagent',
                name: 'app',
                version: 'v1',
                created_at: null,
                size: 0,
                status: 'not_pushed',
            }],
        };
        const adminContainer = {
            container_id: 'container-1',
            status: 'deleted',
            endpoint: null,
            started_at: null,
            expires_at: null,
            cpu_usage: null,
            memory_usage: 12.5,
            image: 'registry.test:5000/testagent/app:v1',
            user_id: 'user-1',
            gitee_user: 'alice',
            gitee_repository: 'repo',
            gitee_branch: null,
            gitee_url: 'https://gitee.com',
            created_at: '2026-09-08T00:00:00Z',
            expiration_hours: 0,
            authorize_general_account: true,
            deleted_at: '2026-09-08T01:00:00Z',
            business_deleted: true,
        };
        const responses = [
            jsonResponse(200, userStatus),
            jsonResponse(200, imageList),
            jsonResponse(200, { containers: [adminContainer] }),
            jsonResponse(200, { container_id: 'container-1', expires_at: null }),
        ];
        const transport = vi.fn(async (): Promise<RestHttpResponse> => responses.shift()!);
        const client = new RestClient('https://api.example.test', { transport, operatorUserId: 'admin-1' });

        await expect(client.user.getContainer('container-1')).resolves.toEqual(userStatus);
        await expect(client.admin.listImages()).resolves.toEqual(imageList);
        await expect(client.admin.listContainers()).resolves.toEqual({ containers: [adminContainer] });
        await expect(client.admin.setExpiration('container-1', { expiration_hours: 0 }))
            .resolves.toEqual({ container_id: 'container-1', expires_at: null });
    });

    it('maps empty URLs, HTTP errors, invalid JSON, and network failures to stable errors', async () => {
        const emptyUrlTransport = createTransport(jsonResponse(200, {}));
        const emptyUrlClient = new RestClient('', { transport: emptyUrlTransport.transport });

        await expect(emptyUrlClient.user.getContainer('id')).rejects.toMatchObject({
            kind: 'configuration',
            code: REST_ERROR_CODES.API_URL_MISSING,
            message: '未配置后端 TestAgent Cloud 管理服务的 API 地址',
        });
        expect(emptyUrlTransport.transport).not.toHaveBeenCalled();

        for (const statusCode of [400, 401, 404, 409, 500, 502]) {
            const { transport } = createTransport(jsonResponse(statusCode, {
                code: `api_${statusCode}`,
                message: `错误 ${statusCode}`,
            }));
            const client = new RestClient('http://api.example.test', { transport });

            await expect(client.user.getContainer('id')).rejects.toMatchObject({
                kind: 'http',
                code: `api_${statusCode}`,
                statusCode,
                message: `错误 ${statusCode}`,
            });
        }

        const invalidJson = createTransport({ statusCode: 200, body: Buffer.from('not-json') });
        await expect(new RestClient('http://api.example.test', { transport: invalidJson.transport }).user.getContainer('id'))
            .rejects.toMatchObject({ kind: 'response', code: REST_ERROR_CODES.INVALID_RESPONSE });

        const networkFailure = createTransport(new Error('connection refused'));
        await expect(new RestClient('http://api.example.test', { transport: networkFailure.transport }).user.getContainer('id'))
            .rejects.toMatchObject({ kind: 'network', code: REST_ERROR_CODES.NETWORK });
    });

    it('maps a successful empty response to void for action endpoints', async () => {
        const { transport } = createTransport({ statusCode: 204, body: Buffer.alloc(0) });
        const client = new RestClient({ baseUrl: 'http://api.example.test', transport });

        await expect(client.user.stopContainer('id')).resolves.toBeUndefined();
    });

    it('returns raw text for the administrator container log endpoint', async () => {
        const { requests, transport } = createTransport({
            statusCode: 200,
            body: Buffer.from('line 1\nline 2\n', 'utf8'),
        });
        const client = new RestClient({ baseUrl: 'http://api.example.test', transport, operatorUserId: 'admin-1' });

        await expect(client.admin.getContainerLog('container-1')).resolves.toBe('line 1\nline 2\n');
        expect(requests[0].headers.Accept).toBe('text/plain');
        expect(requests[0].headers[ADMIN_OPERATOR_USER_ID_HEADER]).toBe('admin-1');
    });

    it('maps an unauthorized administrator response and keeps the operator header', async () => {
        const { requests, transport } = createTransport(jsonResponse(401, {
            code: 'unauthorized',
            message: '未认证',
        }));
        const client = new RestClient('http://api.example.test', { transport, operatorUserId: 'admin-1' });

        await expect(client.admin.getState()).rejects.toMatchObject({
            kind: 'http',
            code: 'unauthorized',
            statusCode: 401,
            message: '未认证',
        });
        expect(requests[0].headers[ADMIN_OPERATOR_USER_ID_HEADER]).toBe('admin-1');
    });

    it('rejects unsafe multipart filenames', () => {
        expect(() => buildMultipartBody({
            file: Buffer.from('tar'),
            filename: 'image\n.tar',
            auto_push: false,
        })).toThrowError(new RestClientError('request', REST_ERROR_CODES.REQUEST, '镜像文件名无效'));
    });

    it('rejects malformed API URLs before making a request', async () => {
        const { transport } = createTransport(jsonResponse(200, {}));
        const error = await clientError(new RestClient('ftp://api.example.test', { transport }));

        expect(error).toBeInstanceOf(RestClientError);
        expect(error).toMatchObject({ kind: 'configuration', code: REST_ERROR_CODES.INVALID_API_URL });
        expect(transport).not.toHaveBeenCalled();
    });
});

async function clientError(client: RestClient): Promise<unknown> {
    try {
        await client.user.getContainer('id');
    } catch (error) {
        return error;
    }
    throw new Error('Expected the client request to fail');
}

function readJsonBody(request: RestHttpRequest): unknown {
    expect(request.headers['Content-Type']).toBe('application/json');
    return JSON.parse(Buffer.from(request.body ?? '').toString('utf8')) as unknown;
}

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected the test HTTP server to expose a TCP address');
    }
    return address.port;
}

async function close(server: http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}
