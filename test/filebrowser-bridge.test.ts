import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
    FileBrowserBridge,
    FileBrowserBridgeError,
    getFileBrowserFrameSource,
    probeFileBrowserPage,
    validateFileBrowserUrl,
} from '../src/filebrowserBridge';

interface TestResponse {
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

describe('FileBrowser bridge', () => {
    it('logs in once, consumes a one-time ticket, and proxies subpaths and bodies with JWT auth', async () => {
        const upstreamRequests: Array<{ method: string; url: string; authorization?: string; password?: string | string[]; body: string }> = [];
        let upstreamPort = 0;
        const upstream = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', chunk => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                const entry = {
                    method: request.method ?? '',
                    url: request.url ?? '',
                    authorization: request.headers.authorization,
                    password: request.headers['x-password'],
                    body: Buffer.concat(chunks).toString('utf8'),
                };
                upstreamRequests.push(entry);
                if (request.url?.startsWith('/fb/api/auth/login?')) {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ token: 'jwt-secret' }));
                    return;
                }
                if (request.url === '/fb/' && request.headers.authorization === 'Bearer jwt-secret') {
                    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    response.end(`<html><script src="http://127.0.0.1:${upstreamPort}/fb/static/app.js"></script><link href="/fb/static/app.css"></html>`);
                    return;
                }
                if (request.url === '/fb/static/app.js') {
                    response.writeHead(200, { 'Content-Type': 'application/javascript' });
                    response.end('window.filebrowserLoaded = true;');
                    return;
                }
                if (request.url === '/fb/api/resources?path=%2Ffoo') {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ ok: true }));
                    return;
                }
                if (request.url === '/fb/upload' && request.method === 'POST') {
                    response.writeHead(201, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify({ uploaded: true }));
                    return;
                }
                response.writeHead(404);
                response.end();
            });
        });
        upstreamPort = await listen(upstream);
        const bridge = new FileBrowserBridge({ requestTimeoutMs: 2_000 });

        try {
            const session = await bridge.createSession({
                baseUrl: `http://127.0.0.1:${upstreamPort}/fb/`,
                username: 'admin user',
                password: 'p@ ss#',
                context: 'admin-generation-1',
            });
            expect(session.frameUrl).toMatch(/^http:\/\/localhost:\d+\/ticket\/[A-Za-z0-9_-]+$/);
            expect(session.frameUrl).not.toContain('p@ ss#');
            expect(session.frameUrl).not.toContain('jwt-secret');

            const ticketResponse = await request(session.frameUrl);
            expect(ticketResponse.statusCode).toBe(303);
            expect(ticketResponse.headers.location).toBe('/');
            const cookie = ticketResponse.headers['set-cookie']?.[0]?.split(';', 1)[0];
            expect(cookie).toMatch(/^testagent_filebrowser_session=/);
            expect(ticketResponse.headers['set-cookie']?.[0]).toContain('SameSite=None; Secure');

            const page = await request(new URL('/', session.frameUrl).toString(), { headers: { Cookie: cookie } });
            expect(page.statusCode).toBe(200);
            expect(page.body.toString('utf8')).toContain('src="/static/app.js"');
            expect(page.body.toString('utf8')).toContain('href="/static/app.css"');
            expect(page.body.toString('utf8')).not.toContain('http://127.0.0.1/upstream');

            const script = await request(new URL('/static/app.js', session.frameUrl).toString(), { headers: { Cookie: cookie } });
            expect(script.statusCode).toBe(200);
            expect(script.body.toString('utf8')).toContain('filebrowserLoaded');

            const resources = await request(new URL('/api/resources?path=%2Ffoo', session.frameUrl).toString(), { headers: { Cookie: cookie } });
            expect(resources.statusCode).toBe(200);
            expect(resources.body.toString('utf8')).toContain('"ok":true');

            const upload = await request(new URL('/upload', session.frameUrl).toString(), {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
                body: 'upload-body',
            });
            expect(upload.statusCode).toBe(201);

            const secondTicketResponse = await request(session.frameUrl);
            expect(secondTicketResponse.statusCode).toBe(404);
            const missingSession = await request(new URL('/', session.frameUrl).toString());
            expect(missingSession.statusCode).toBe(401);

            const login = upstreamRequests.find(entry => entry.url.startsWith('/fb/api/auth/login?'));
            expect(login).toMatchObject({
                method: 'POST',
                url: '/fb/api/auth/login?username=admin%20user',
                password: 'p%40%20ss%23',
            });
            expect(upstreamRequests.filter(entry => entry.url !== login?.url).every(entry => entry.authorization === 'Bearer jwt-secret')).toBe(true);
            expect(upstreamRequests.find(entry => entry.url === '/fb/upload')?.body).toBe('upload-body');

            session.dispose();
            bridge.dispose();
        } finally {
            bridge.dispose();
            await close(upstream);
        }
    });

    it('rejects unsafe base URLs and detects frame policies before creating a session', async () => {
        expect(() => validateFileBrowserUrl('https://user:password@example.test/files')).toThrow(FileBrowserBridgeError);
        expect(() => validateFileBrowserUrl('https://example.test/files?token=secret')).toThrow(FileBrowserBridgeError);
        expect(getFileBrowserFrameSource('https://example.test/files/')).toBe('https://example.test');

        const blocked = http.createServer((_request, response) => {
            response.writeHead(200, {
                'Content-Type': 'text/html',
                'X-Frame-Options': 'DENY',
            });
            response.end('<html></html>');
        });
        const port = await listen(blocked);
        try {
            await expect(probeFileBrowserPage(`http://127.0.0.1:${port}/files`)).rejects.toMatchObject({
                code: 'filebrowser_frame_blocked',
            });
        } finally {
            await close(blocked);
        }
    });
});

function request(url: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}): Promise<TestResponse> {
    return new Promise<TestResponse>((resolve, reject) => {
        const request = http.request(url, {
            method: options.method ?? 'GET',
            headers: options.headers,
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.once('end', () => resolve({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
            response.once('error', reject);
        });
        request.once('error', reject);
        if (options.body) {
            request.write(options.body);
        }
        request.end();
    });
}

function listen(server: http.Server): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('server did not expose a port'));
                return;
            }
            resolve(address.port);
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}
