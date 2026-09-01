import * as vscode from 'vscode';

export const USER_AUTHENTICATION_PROVIDER = 'tscode-oauth';

export interface UserInfo {
    userId: string;
    userName: string;
}

export type SessionGetter = () => Thenable<vscode.AuthenticationSession | undefined>;

export async function getSession(): Promise<vscode.AuthenticationSession | undefined> {
    return vscode.authentication.getSession(USER_AUTHENTICATION_PROVIDER, [], {
        createIfNone: false,
        silent: true,
    });
}

export class UserIdProvider {
    constructor(private readonly sessionGetter: SessionGetter = getSession) {
    }

    public async getCurrentUser(): Promise<UserInfo> {
        try {
            const session = await this.sessionGetter();
            const account = session?.account;
            return {
                userId: asNonEmptyString(account?.id),
                userName: asNonEmptyString(account?.label),
            };
        } catch {
            return emptyUserInfo();
        }
    }

    public async getCurrentUserId(): Promise<string> {
        return (await this.getCurrentUser()).userId;
    }
}

const defaultUserIdProvider = new UserIdProvider();

export function getCurrentUser(): Promise<UserInfo> {
    return defaultUserIdProvider.getCurrentUser();
}

export function getCurrentUserId(): Promise<string> {
    return defaultUserIdProvider.getCurrentUserId();
}

function asNonEmptyString(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : '';
}

function emptyUserInfo(): UserInfo {
    return { userId: '', userName: '' };
}
