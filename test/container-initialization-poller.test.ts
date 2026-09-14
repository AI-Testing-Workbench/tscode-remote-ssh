import { describe, expect, it, vi } from 'vitest';
import type { ContainerStatusResponse, GitCredentialSubmitRequest, GitStateResponse } from '../src/api/models';
import { ContainerInitializationPoller } from '../src/containerInitializationPoller';
import { RestClientError, type GitRestApi, type UserRestApi } from '../src/api/restClient';

describe('ContainerInitializationPoller', () => {
    it('runs the complete pending-to-running 码云 initialization sequence in order', async () => {
        const statuses = [
            containerStatus('pending', undefined),
            containerStatus('starting', 'pending'),
            containerStatus('processing', 'pending'),
            containerStatus('running', 'pending'),
            containerStatus('running', 'initialized'),
        ];
        const gitStates: GitStateResponse[] = [
            { git_status: 'starting' },
            { git_status: 'credential_required' },
            { git_status: 'processing' },
            { git_status: 'initialized' },
        ];
        const calls: string[] = [];
        const userApi = {
            getContainer: vi.fn(async () => {
                calls.push('container');
                return statuses.shift()!;
            }),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => {
                calls.push('git');
                return gitStates.shift()!;
            }),
            submitGitCredential: vi.fn(async () => {
                calls.push('credential');
            }),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const credential = credentialRequest();
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
            credentialPrompt: vi.fn(async () => credential),
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
            endpoint: null,
        })).resolves.toMatchObject({ gitStatus: 'initialized', attempts: 5 });
        expect(calls).toEqual(['container', 'git', 'container', 'git', 'credential', 'container', 'git', 'container', 'git', 'container']);
        expect(gitApi.getGitState).toHaveBeenCalledWith('service-1', 'user-1');
        expect(gitApi.submitGitCredential).toHaveBeenCalledWith('service-1', 'user-1', credential);
    });

    it('reopens credentials after credential_rejected and never validates endpoint', async () => {
        const userApi = {
            getContainer: vi.fn()
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockResolvedValueOnce({ git_status: 'credential_required' })
                .mockResolvedValueOnce({ git_status: 'credential_rejected' })
                .mockResolvedValueOnce({ git_status: 'initialized' }),
            submitGitCredential: vi.fn(async () => undefined),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const prompt = vi.fn()
            .mockResolvedValueOnce(credentialRequest('first'))
            .mockResolvedValueOnce(credentialRequest('second'));
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            sleep: vi.fn(async () => undefined),
            credentialPrompt: prompt,
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
            endpoint: 'not-an-ip:invalid',
        })).resolves.toMatchObject({ gitStatus: 'initialized' });
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(gitApi.submitGitCredential).toHaveBeenCalledWith('service-1', 'user-1', credentialRequest('first'));
        expect(gitApi.submitGitCredential).toHaveBeenCalledWith('service-1', 'user-1', credentialRequest('second'));
    });

    it('reports user cancellation once and stops without submitting credentials', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'credential_required' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(async () => undefined),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            maxAttempts: 3,
            sleep: vi.fn(async () => undefined),
            credentialPrompt: vi.fn(async () => undefined),
        });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'failed_user_cancelled' });
        expect(gitApi.reportUserCancelled).toHaveBeenCalledOnce();
        expect(gitApi.reportUserCancelled).toHaveBeenCalledWith('service-1', 'user-1');
        expect(gitApi.submitGitCredential).not.toHaveBeenCalled();
    });

    it('retries temporary ordinary and 码云 status failures without reporting a fake 码云 failure', async () => {
        const userApi = {
            getContainer: vi.fn()
                .mockRejectedValueOnce(new Error('temporary status failure'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockRejectedValueOnce(new Error('temporary 码云 failure'))
                .mockResolvedValueOnce({ git_status: 'initialized' }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const sleep = vi.fn(async () => undefined);
        const poller = new ContainerInitializationPoller({ userApi, gitApi, sleep });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .resolves.toMatchObject({ gitStatus: 'initialized' });
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(gitApi.reportUserCancelled).not.toHaveBeenCalled();
    });

    it('retries the API error classes used during service creation', async () => {
        for (const [statusCode, code] of [
            [401, 'unauthorized'],
            [403, 'forbidden'],
            [404, 'not_found'],
            [408, 'request_timeout'],
            [409, 'conflict'],
            [429, 'too_many_requests'],
            [500, 'server_error'],
            [502, 'bad_gateway'],
        ] as const) {
            const userApi = {
                getContainer: vi.fn()
                    .mockRejectedValueOnce(new RestClientError('http', code, `status ${statusCode}`, statusCode))
                    .mockResolvedValueOnce(containerStatus('running', 'initialized')),
            } as Pick<UserRestApi, 'getContainer'>;
            const gitApi = {
                getGitState: vi.fn(),
                submitGitCredential: vi.fn(),
                reportUserCancelled: vi.fn(),
            } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
            const poller = new ContainerInitializationPoller({
                userApi,
                gitApi,
                sleep: vi.fn(async () => undefined),
            });

            await expect(poller.initialize({
                containerId: `container-${statusCode}`,
                serviceId: `service-${statusCode}`,
                operatorUserId: 'user-1',
            })).resolves.toMatchObject({ gitStatus: 'initialized' });
            expect(userApi.getContainer).toHaveBeenCalledTimes(2);
        }
    });

    it('stops on an unknown 码云 response without submitting or reporting it', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('running', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'unknown_status' as never })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({ userApi, gitApi, sleep: vi.fn(async () => undefined) });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'failed_unexpected_state' });
        expect(gitApi.submitGitCredential).not.toHaveBeenCalled();
        expect(gitApi.reportUserCancelled).not.toHaveBeenCalled();
    });

    it('ends on failed 码云 and ordinary states without another status request', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('running', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'failed_git' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({ userApi, gitApi, sleep: vi.fn(async () => undefined) });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'failed_git' });
        expect(userApi.getContainer).toHaveBeenCalledOnce();

        const failedUserApi = {
            getContainer: vi.fn(async () => containerStatus('failed', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const failedPoller = new ContainerInitializationPoller({
            userApi: failedUserApi,
            gitApi,
            sleep: vi.fn(async () => undefined),
        });
        await expect(failedPoller.initialize({ containerId: 'container-2', serviceId: 'service-2', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'failed_container' });
        expect(gitApi.getGitState).toHaveBeenCalledOnce();
    });

    it('shares one in-flight promise for the same creation context', async () => {
        let release: (() => void) | undefined;
        const userApi = {
            getContainer: vi.fn(() => new Promise<ContainerStatusResponse>(resolve => {
                release = () => resolve(containerStatus('running', 'initialized'));
            })),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({ userApi, gitApi });
        const input = { containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' };

        const first = poller.initialize(input);
        const second = poller.initialize(input);
        expect(second).toBe(first);
        expect(userApi.getContainer).toHaveBeenCalledOnce();
        release?.();
        await expect(first).resolves.toMatchObject({ gitStatus: 'initialized' });
    });

    it('stops a cancelled creation before querying 码云 or opening credentials', async () => {
        const controller = new AbortController();
        let resolveStatus: ((value: ContainerStatusResponse) => void) | undefined;
        const userApi = {
            getContainer: vi.fn(() => new Promise<ContainerStatusResponse>(resolve => {
                resolveStatus = resolve;
            })),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const prompt = vi.fn();
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            credentialPrompt: prompt,
        });

        const pending = poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(userApi.getContainer).toHaveBeenCalledOnce());
        controller.abort();
        resolveStatus?.(containerStatus('pending', 'pending'));

        await expect(pending).rejects.toMatchObject({ code: 'creation_cancelled' });
        expect(gitApi.getGitState).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('rejects missing creation identifiers before making API calls', async () => {
        const userApi = { getContainer: vi.fn() } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({ userApi, gitApi });

        await expect(poller.initialize({ containerId: '', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'container_id_missing' });
        await expect(poller.initialize({ containerId: 'container-1', serviceId: '', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'service_id_missing' });
        expect(userApi.getContainer).not.toHaveBeenCalled();
    });
});

function containerStatus(status: string, git_fin_status: string | undefined): ContainerStatusResponse {
    return {
        container_id: 'container-1',
        status,
        gitee_user: '',
        gitee_repository: '',
        ...(git_fin_status === undefined ? {} : { git_fin_status }),
        endpoint: null,
    };
}

function credentialRequest(suffix = 'credential'): GitCredentialSubmitRequest {
    return {
        type: 'password',
        git_username: `git-user-${suffix}`,
        git_email: '',
        git_password: `secret-${suffix}`,
        persist: false,
    };
}
