import { describe, expect, it, vi } from 'vitest';
import type { ContainerStatusResponse, GitCredentialSubmitRequest, GitStateResponse } from '../src/api/models';
import { ContainerInitializationPoller } from '../src/containerInitializationPoller';
import { RestClientError, type GitRestApi, type UserRestApi } from '../src/api/restClient';
import { promptForGitCredentials } from '../src/gitCredentialPrompt';

describe('ContainerInitializationPoller', () => {
    it('完整验证服务从创建中到运行中的码云初始化流程', async () => {
        const statuses = [
            containerStatus('pending', undefined),
            containerStatus('starting', 'pending'),
            containerStatus('processing', 'pending'),
            containerStatus('running', 'pending'),
            containerStatus('running', 'initialized'),
        ];
        const gitStates: GitStateResponse[] = [
            { git_status: 'waiting' },
            { git_status: 'starting' },
            { git_status: 'credential_required' },
            { git_status: 'processing' },
        ];
        const calls: string[] = [];
        const runGitClone = vi.fn(async () => { calls.push('clone'); });
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
            runGitClone,
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
        expect(calls).toEqual([
            'container', 'git', 'clone',
            'container', 'git',
            'container', 'git', 'credential',
            'container', 'git',
            'container',
        ]);
        expect(runGitClone).toHaveBeenCalledOnce();
        expect(runGitClone).toHaveBeenCalledWith(expect.objectContaining({ container_id: 'container-1', endpoint: '127.0.0.1:2222' }), expect.any(AbortSignal));
        expect(gitApi.getGitState).toHaveBeenCalledWith('service-1', 'user-1');
        expect(gitApi.submitGitCredential).toHaveBeenCalledWith('service-1', 'user-1', credential);
    });

    it('凭证被拒绝后重新打开输入并使用实时服务地址', async () => {
        const userApi = {
            getContainer: vi.fn()
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockResolvedValueOnce({ git_status: 'waiting' })
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
            runGitClone: vi.fn(async () => undefined),
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

    it('先启动码云状态轮询，再执行初始化命令并等待两者完成', async () => {
        const calls: string[] = [];
        let finishClone: (() => void) | undefined;
        const userApi = {
            getContainer: vi.fn()
                .mockImplementationOnce(async () => containerStatus('pending', 'pending'))
                .mockImplementationOnce(async () => containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => {
                calls.push('git-poll');
                return { git_status: 'waiting' };
            }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const runGitClone = vi.fn(() => {
            calls.push('clone-start');
            return new Promise<void>(resolve => { finishClone = resolve; });
        });
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone,
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
        });

        let completed = false;
        const initialization = poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
        }).then(result => {
            completed = true;
            return result;
        });

        await vi.waitFor(() => expect(userApi.getContainer).toHaveBeenCalledTimes(2));
        expect(calls).toEqual(['git-poll', 'clone-start']);
        expect(completed).toBe(false);
        finishClone?.();
        await expect(initialization).resolves.toMatchObject({ gitStatus: 'initialized' });
    });

    it('码云初始化脚本执行失败时终止创建', async () => {
        const userApi = {
            getContainer: vi.fn()
                .mockResolvedValueOnce(containerStatus('pending', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'waiting' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => { throw new Error('远程命令退出状态：1'); }),
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
        })).rejects.toMatchObject({
            code: 'git_clone_execution_failed',
            message: '服务 "container-1" 的码云初始化脚本执行失败',
        });
    });

    it('优先采用初始化脚本已上报的失败状态', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockResolvedValueOnce({ git_status: 'waiting' })
                .mockResolvedValueOnce({ git_status: 'failed_git' }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
            reportGitFailure: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled' | 'reportGitFailure'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => { throw new Error('远程命令退出状态：1'); }),
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
        })).rejects.toMatchObject({ code: 'failed_git' });
        expect(gitApi.reportGitFailure).not.toHaveBeenCalled();
    });

    it('使用允许的码云状态上报本地初始化脚本失败', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'waiting' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
            reportGitFailure: vi.fn(async (_serviceId: string, _userId: string, status: string) => ({ git_status: status })),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled' | 'reportGitFailure'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => { throw new Error('远程命令退出状态：1'); }),
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
        })).rejects.toMatchObject({ code: 'git_clone_execution_failed' });
        expect(gitApi.reportGitFailure).toHaveBeenCalledWith('service-1', 'user-1', 'failed_initialize');
    });

    it('取消创建时中止码云初始化脚本执行', async () => {
        const controller = new AbortController();
        let cloneSignal: AbortSignal | undefined;
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'waiting' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn((_container, signal) => {
                cloneSignal = signal;
                return new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('初始化已取消')), { once: true });
                });
            }),
            statusSyncInterval: 0,
            sleep: vi.fn(async () => controller.abort()),
        });

        await expect(poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
            signal: controller.signal,
        })).rejects.toMatchObject({ code: 'creation_cancelled' });
        expect(cloneSignal?.aborted).toBe(true);
    });

    it('reports user cancellation once and stops without submitting credentials', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockResolvedValueOnce({ git_status: 'waiting' })
                .mockResolvedValue({ git_status: 'credential_required' }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(async () => undefined),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => undefined),
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

    it('reports cancellation immediately when the password is empty', async () => {
        let resolveErrorMessage: (() => void) | undefined;
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('pending', 'pending')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockResolvedValueOnce({ git_status: 'waiting' })
                .mockResolvedValue({ git_status: 'credential_required' }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(async () => undefined),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const showInputBox = vi.fn()
            .mockResolvedValueOnce('user')
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce('');
        const showErrorMessage = vi.fn(() => new Promise<void>(resolve => {
            resolveErrorMessage = resolve;
        }));
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => undefined),
            sleep: vi.fn(async () => undefined),
            credentialPrompt: () => promptForGitCredentials({
                identityReader: { read: vi.fn(async () => ({ username: '', email: '' })) },
                showInputBox,
                showQuickPick: vi.fn(),
                showErrorMessage,
            }),
        });

        const initialization = poller.initialize({
            containerId: 'container-1',
            serviceId: 'service-1',
            operatorUserId: 'user-1',
        });
        const initializationExpectation = expect(initialization).rejects.toMatchObject({ code: 'failed_user_cancelled' });
        await vi.waitFor(() => expect(gitApi.reportUserCancelled).toHaveBeenCalledWith('service-1', 'user-1'));
        resolveErrorMessage?.();

        await initializationExpectation;
        expect(gitApi.submitGitCredential).not.toHaveBeenCalled();
    });

    it('retries temporary ordinary and 码云 status failures without reporting a fake 码云 failure', async () => {
        const userApi = {
            getContainer: vi.fn()
                .mockRejectedValueOnce(new Error('temporary status failure'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'pending'))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn()
                .mockRejectedValueOnce(new Error('temporary 码云 failure'))
                .mockResolvedValueOnce({ git_status: 'waiting' })
                .mockResolvedValueOnce({ git_status: 'initialized' }),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const sleep = vi.fn(async () => undefined);
        const runGitClone = vi.fn(async () => undefined);
        const poller = new ContainerInitializationPoller({ userApi, gitApi, runGitClone, sleep });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .resolves.toMatchObject({ gitStatus: 'initialized' });
        expect(sleep).toHaveBeenCalledTimes(4);
        expect(runGitClone).toHaveBeenCalledOnce();
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
                    .mockResolvedValueOnce(containerStatus('running', 'pending'))
                    .mockResolvedValueOnce(containerStatus('running', 'initialized')),
            } as Pick<UserRestApi, 'getContainer'>;
            const gitApi = {
                getGitState: vi.fn(async () => ({ git_status: 'waiting' })),
                submitGitCredential: vi.fn(),
                reportUserCancelled: vi.fn(),
            } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
            const poller = new ContainerInitializationPoller({
                userApi,
                gitApi,
                runGitClone: vi.fn(async () => undefined),
                sleep: vi.fn(async () => undefined),
            });

            await expect(poller.initialize({
                containerId: `container-${statusCode}`,
                serviceId: `service-${statusCode}`,
                operatorUserId: 'user-1',
            })).resolves.toMatchObject({ gitStatus: 'initialized' });
            expect(userApi.getContainer).toHaveBeenCalledTimes(3);
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

    it('keeps the API final failure code when the container reports initialization failure', async () => {
        const userApi = {
            getContainer: vi.fn(async () => containerStatus('failed', 'failed_initialize')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({ userApi, gitApi, sleep: vi.fn(async () => undefined) });

        await expect(poller.initialize({ containerId: 'container-1', serviceId: 'service-1', operatorUserId: 'user-1' }))
            .rejects.toMatchObject({ code: 'failed_initialize' });
        expect(gitApi.getGitState).not.toHaveBeenCalled();
    });

    it('shares one in-flight promise for the same creation context', async () => {
        let release: (() => void) | undefined;
        const userApi = {
            getContainer: vi.fn()
                .mockImplementationOnce(() => new Promise<ContainerStatusResponse>(resolve => {
                    release = () => resolve(containerStatus('running', 'pending'));
                }))
                .mockResolvedValueOnce(containerStatus('running', 'initialized')),
        } as Pick<UserRestApi, 'getContainer'>;
        const gitApi = {
            getGitState: vi.fn(async () => ({ git_status: 'waiting' })),
            submitGitCredential: vi.fn(),
            reportUserCancelled: vi.fn(),
        } as unknown as Pick<GitRestApi, 'getGitState' | 'submitGitCredential' | 'reportUserCancelled'>;
        const poller = new ContainerInitializationPoller({
            userApi,
            gitApi,
            runGitClone: vi.fn(async () => undefined),
            statusSyncInterval: 0,
            sleep: vi.fn(async () => undefined),
        });
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
        endpoint: '127.0.0.1:2222',
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
