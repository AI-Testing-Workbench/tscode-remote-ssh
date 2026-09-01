import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
        const client = new RestClient('https://api.example.test/v1///', { transport });

        await client.user.createContainer({ user_id: 'user-1' });
        await client.user.getContainerIds({ user_id: 'user-1', gitee_repository: 'repo' });
        await client.user.getContainer('container/1');
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
        await client.admin.getContainer('container/1');
        await client.admin.startContainer('container/1');
        await client.admin.stopContainer('container/1');
        await client.admin.restartContainer('container/1');
        await client.admin.deleteContainer('container/1');
        await client.admin.permanentDeleteContainer('container/1');
        await client.admin.setExpiration('container/1', { expiration_hours: 1 });
        await client.admin.restoreContainer('container/1', { expiration_hours: 1 });
        await client.admin.getContainerLimit();
        await client.admin.setContainerLimit({ container_limit: 3 });
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
            'GET /v1/admin/containers/container%2F1',
            'POST /v1/admin/containers/container%2F1/start',
            'POST /v1/admin/containers/container%2F1/stop',
            'POST /v1/admin/containers/container%2F1/restart',
            'POST /v1/admin/containers/container%2F1/delete',
            'POST /v1/admin/containers/container%2F1/permanent-delete',
            'POST /v1/admin/containers/container%2F1/expiration',
            'POST /v1/admin/containers/container%2F1/restore',
            'GET /v1/admin/containers/limit',
            'POST /v1/admin/containers/limit',
            'POST /v1/admin/whitelist-users',
            'GET /v1/admin/whitelist-users',
            'POST /v1/admin/whitelist-users/delete',
            'POST /v1/admin/admin-users',
            'GET /v1/admin/admin-users',
            'POST /v1/admin/admin-users/delete',
        ]);

        expect(requests[1].url.search).toBe('?user_id=user-1&gitee_repository=repo');
        expect(Buffer.from(requests[0].body ?? '').toString('utf8')).toBe('{"user_id":"user-1"}');
        const multipartBody = Buffer.from(requests[7].body ?? '').toString('utf8');
        expect(requests[7].headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(multipartBody).toContain('name="auto_push"');
        expect(multipartBody).toContain('name="file"; filename="image.tar"');
        expect(multipartBody).toContain('tar');
    });

    it('maps empty URLs, HTTP errors, invalid JSON, and network failures to stable errors', async () => {
        const emptyUrlTransport = createTransport(jsonResponse(200, {}));
        const emptyUrlClient = new RestClient('', { transport: emptyUrlTransport.transport });

        await expect(emptyUrlClient.user.getContainer('id')).rejects.toMatchObject({
            kind: 'configuration',
            code: REST_ERROR_CODES.API_URL_MISSING,
            message: '未配置后端 REST API 地址',
        });
        expect(emptyUrlTransport.transport).not.toHaveBeenCalled();

        for (const statusCode of [400, 404, 409, 500, 502]) {
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
