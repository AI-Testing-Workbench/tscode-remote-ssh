import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import SSHConfig, { Directive, Line, Section } from 'ssh-config';
import { expandPath } from './common/files';

export const DEFAULT_CONTAINER_CONFIG_SETTING = '~/.local/share/testagent/config';
export const CONTAINER_ID_DIRECTIVE = 'ContainerId';
export const EXPIRES_AT_DIRECTIVE = 'ExpiresAt';
export const IGNORE_UNKNOWN_VALUE = 'ContainerId,ExpiresAt';
export const SKIP_KNOWN_HOSTS_DIRECTIVE = 'StrictHostKeyChecking';
export const USER_KNOWN_HOSTS_FILE_DIRECTIVE = 'UserKnownHostsFile';
export const USER_DIRECTIVE = 'User';
export const NULL_KNOWN_HOSTS_FILE = '/dev/null';
const DIRECTORY_CONFIG_FILE = 'config';

export interface ContainerConfigEntry {
    containerId: string;
    host: string;
    hostName?: string;
    port?: number;
    expiresAt?: string;
}

export interface ContainerConfigDocument {
    config: SSHConfig;
    originalText: string;
}

export interface ContainerConfigFileSystem {
    mkdir(directory: string, options: { recursive: true }): Promise<void>;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string, options?: { flag?: string; mode?: number }): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(filePath: string): Promise<void>;
}

export interface UpsertContainerOptions {
    skipKnownHostsCheck?: boolean;
    userName?: string;
}

export function getConfiguredContainerConfigPath(): string {
    const configuredPath = vscode.workspace.getConfiguration('testagnet.remote').get<unknown>(
        'configFile',
        DEFAULT_CONTAINER_CONFIG_SETTING,
    );
    if (typeof configuredPath === 'string' && configuredPath.trim()) {
        return resolveConfiguredPath(configuredPath.trim());
    }
    return resolveConfiguredPath(DEFAULT_CONTAINER_CONFIG_SETTING);
}

export function getContainerConfigEntries(config: SSHConfig): ContainerConfigEntry[] {
    const entries: ContainerConfigEntry[] = [];
    for (const line of config) {
        if (!isHostSection(line)) {
            continue;
        }

        const containerId = getDirectiveValue(line.config, isContainerIdDirective);
        if (!containerId) {
            continue;
        }

        const hostName = getDirectiveValue(line.config, isHostNameDirective);
        const port = parsePort(getDirectiveValue(line.config, isPortDirective));
        const expiresAt = getDirectiveValue(line.config, isExpiresAtDirective);
        entries.push({
            containerId,
            host: getHostValue(line),
            ...(hostName ? { hostName } : {}),
            ...(port !== undefined ? { port } : {}),
            ...(expiresAt ? { expiresAt } : {}),
        });
    }
    return entries;
}

export class ContainerConfig {
    private readonly fileSystem: ContainerConfigFileSystem;

    constructor(
        public readonly filePath: string = getConfiguredContainerConfigPath(),
        fileSystem: ContainerConfigFileSystem = nodeFileSystem,
    ) {
        this.fileSystem = fileSystem;
    }

    public async read(): Promise<ContainerConfigDocument> {
        await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true });

        let originalText: string;
        try {
            originalText = await this.fileSystem.readFile(this.filePath);
        } catch (error) {
            if (getErrorCode(error) !== 'ENOENT') {
                throw error;
            }

            try {
                await this.fileSystem.writeFile(this.filePath, '', { flag: 'wx', mode: 0o600 });
            } catch (createError) {
                if (getErrorCode(createError) !== 'EEXIST') {
                    throw createError;
                }
            }
            originalText = await this.fileSystem.readFile(this.filePath);
        }

        return {
            config: SSHConfig.parse(originalText),
            originalText,
        };
    }

    public async write(document: ContainerConfigDocument): Promise<boolean> {
        normalizeContainerSections(document.config);
        const nextText = SSHConfig.stringify(document.config);
        if (nextText === document.originalText) {
            return false;
        }

        await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true });
        await this.atomicWrite(nextText);
        document.originalText = nextText;
        return true;
    }

    public list(config: SSHConfig): ContainerConfigEntry[] {
        return getContainerConfigEntries(config);
    }

    public upsertContainer(
        config: SSHConfig,
        entry: ContainerConfigEntry,
        options: UpsertContainerOptions = {},
    ): boolean {
        if (!entry.containerId.trim()) {
            throw new Error('ContainerId cannot be empty');
        }

        const section = findContainerSection(config, entry.containerId);
        if (!section) {
            if (!entry.host.trim()) {
                throw new Error('Host cannot be empty for a new container');
            }
            const newSection = createContainerSection(
                config,
                entry,
                options.skipKnownHostsCheck === true,
                options.userName,
            );
            config.push(newSection);
            this.ensureIgnoreUnknown(newSection);
            normalizeContainerSection(newSection);
            return true;
        }

        let changed = this.ensureIgnoreUnknown(section);
        if (options.skipKnownHostsCheck === true) {
            changed = this.ensureSkipKnownHostsCheck(section) || changed;
        }
        if (options.userName?.trim()) {
            changed = setDirective(
                section.config,
                isUserDirective,
                USER_DIRECTIVE,
                options.userName.trim(),
                true,
            ) || changed;
        }
        if (entry.host.trim() && getHostValue(section) !== entry.host) {
            section.value = entry.host;
            section.quoted = /\s/.test(entry.host);
            changed = true;
        }

        if (entry.hostName?.trim()) {
            changed = setDirective(
                section.config,
                isHostNameDirective,
                'HostName',
                entry.hostName,
                true,
            ) || changed;
        }
        if (entry.port !== undefined) {
            changed = setDirective(section.config, isPortDirective, 'Port', String(entry.port), true) || changed;
        }

        changed = setDirective(section.config, isContainerIdDirective, CONTAINER_ID_DIRECTIVE, entry.containerId) || changed;
        if (entry.expiresAt === undefined) {
            changed = removeDirectives(section.config, isExpiresAtDirective) || changed;
        } else {
            changed = setDirective(section.config, isExpiresAtDirective, EXPIRES_AT_DIRECTIVE, entry.expiresAt) || changed;
        }
        changed = normalizeContainerSection(section) || changed;
        return changed;
    }

    public setUserName(config: SSHConfig, userName: string): boolean {
        const normalizedUserName = userName.trim();
        if (!normalizedUserName) {
            return false;
        }

        let changed = false;
        for (const line of config) {
            if (isHostSection(line) && getDirectiveValue(line.config, isContainerIdDirective)) {
                changed = setDirective(
                    line.config,
                    isUserDirective,
                    USER_DIRECTIVE,
                    normalizedUserName,
                    true,
                ) || changed;
            }
        }
        changed = normalizeContainerSections(config) || changed;
        return changed;
    }

    public ensureUserName(config: SSHConfig, userName: string): boolean {
        const normalizedUserName = userName.trim();
        if (!normalizedUserName) {
            return false;
        }

        let changed = false;
        for (const line of config) {
            if (!isHostSection(line) || !getDirectiveValue(line.config, isContainerIdDirective)) {
                continue;
            }
            const userDirective = findDirective(line.config, isUserDirective);
            if (!userDirective || !directiveValue(userDirective).trim()) {
                changed = setDirective(
                    line.config,
                    isUserDirective,
                    USER_DIRECTIVE,
                    normalizedUserName,
                    true,
                ) || changed;
            }
        }
        changed = normalizeContainerSections(config) || changed;
        return changed;
    }

    public setExpiresAt(config: SSHConfig, containerId: string, expiresAt: string): boolean {
        const section = findContainerSection(config, containerId);
        if (!section) {
            return false;
        }
        let changed = this.ensureIgnoreUnknown(section);
        changed = setDirective(section.config, isExpiresAtDirective, EXPIRES_AT_DIRECTIVE, expiresAt) || changed;
        changed = normalizeContainerSection(section) || changed;
        return changed;
    }

    public removeExpiresAt(config: SSHConfig, containerId: string): boolean {
        const section = findContainerSection(config, containerId);
        if (!section) {
            return false;
        }
        let changed = this.ensureIgnoreUnknown(section);
        changed = removeDirectives(section.config, isExpiresAtDirective) || changed;
        changed = normalizeContainerSection(section) || changed;
        return changed;
    }

    public removeContainer(config: SSHConfig, containerId: string): boolean {
        let changed = false;
        for (let index = config.length - 1; index >= 0; index -= 1) {
            const line = config[index];
            if (isHostSection(line) && sectionHasContainerId(line, containerId)) {
                config.splice(index, 1);
                changed = true;
            }
        }
        return changed;
    }

    public setSkipKnownHostsCheck(config: SSHConfig, enabled: boolean): boolean {
        if (!enabled) {
            return false;
        }

        let changed = false;
        for (const line of config) {
            if (isHostSection(line) && getDirectiveValue(line.config, isContainerIdDirective)) {
                changed = this.ensureSkipKnownHostsCheck(line) || changed;
            }
        }
        changed = normalizeContainerSections(config) || changed;
        return changed;
    }

    private ensureIgnoreUnknown(section: Section): boolean {
        const directive = findDirective(section.config, isIgnoreUnknownDirective);
        if (!directive) {
            const firstCustomDirective = getFirstCustomDirective(section.config);
            const insertionIndex = firstCustomDirective ? section.config.indexOf(firstCustomDirective) : -1;
            return insertDirective(section.config, insertionIndex, {
                param: 'IgnoreUnknown',
                value: IGNORE_UNKNOWN_VALUE,
            });
        }

        const existingValues = directiveValue(directive).split(/[,\s]+/).filter(Boolean);
        const values = [...existingValues];
        for (const requiredValue of [CONTAINER_ID_DIRECTIVE, EXPIRES_AT_DIRECTIVE]) {
            if (!values.some(value => value.toLowerCase() === requiredValue.toLowerCase())) {
                values.push(requiredValue);
            }
        }
        const nextValue = values.join(',');
        if (directiveValue(directive) === nextValue) {
            return false;
        }
        directive.value = nextValue;
        return true;
    }

    private ensureSkipKnownHostsCheck(section: Section): boolean {
        let changed = setDirective(
            section.config,
            isSkipKnownHostsDirective,
            SKIP_KNOWN_HOSTS_DIRECTIVE,
            'no',
            true,
        );
        changed = setDirective(
            section.config,
            isUserKnownHostsFileDirective,
            USER_KNOWN_HOSTS_FILE_DIRECTIVE,
            NULL_KNOWN_HOSTS_FILE,
            true,
        ) || changed;
        return changed;
    }

    private async atomicWrite(content: string): Promise<void> {
        const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try {
            await this.fileSystem.writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
            try {
                await this.fileSystem.rename(temporaryPath, this.filePath);
            } catch (error) {
                if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(getErrorCode(error) ?? '')) {
                    throw error;
                }
                await unlinkIfPresent(this.fileSystem, this.filePath);
                await this.fileSystem.rename(temporaryPath, this.filePath);
            }
        } finally {
            await unlinkIfPresent(this.fileSystem, temporaryPath);
        }
    }
}

function createContainerSection(
    config: SSHConfig,
    entry: ContainerConfigEntry,
    skipKnownHostsCheck: boolean,
    userName?: string,
): Section {
    const section: Section = {
        type: SSHConfig.DIRECTIVE,
        param: 'Host',
        separator: ' ',
        value: entry.host,
        quoted: /\s/.test(entry.host),
        before: config.length ? '\n' : '',
        after: '\n',
        config: new SSHConfig(),
    };

    if (entry.hostName?.trim()) {
        section.config.push(createDirective('HostName', entry.hostName, '\t'));
    }
    if (userName?.trim()) {
        section.config.push(createDirective(USER_DIRECTIVE, userName.trim(), '\t'));
    }
    if (entry.port !== undefined) {
        section.config.push(createDirective('Port', String(entry.port), '\t'));
    }
    section.config.push(createDirective('ContainerId', entry.containerId, '\t'));
    if (entry.expiresAt !== undefined) {
        section.config.push(createDirective('ExpiresAt', entry.expiresAt, '\t'));
    }
    if (skipKnownHostsCheck) {
        section.config.splice(
            0,
            0,
            createDirective(SKIP_KNOWN_HOSTS_DIRECTIVE, 'no', '\t'),
            createDirective(USER_KNOWN_HOSTS_FILE_DIRECTIVE, NULL_KNOWN_HOSTS_FILE, '\t'),
        );
    }
    return section;
}

function normalizeContainerSections(config: SSHConfig): boolean {
    let changed = false;
    for (const line of config) {
        if (isHostSection(line) && getDirectiveValue(line.config, isContainerIdDirective)) {
            changed = normalizeContainerSection(line) || changed;
        }
    }
    return changed;
}

function normalizeContainerHost(section: Section): boolean {
    const host = getHostValue(section).trim();
    if (!host) {
        return false;
    }

    let changed = false;
    const shouldQuote = /\s/.test(host);
    if (Array.isArray(section.value) && shouldQuote) {
        section.value = host;
        changed = true;
    }

    if (shouldQuote && section.quoted !== true) {
        section.quoted = true;
        changed = true;
    } else if (!shouldQuote && section.quoted === true) {
        section.quoted = false;
        changed = true;
    }
    return changed;
}

function normalizeContainerSection(section: Section): boolean {
    let changed = normalizeContainerHost(section);
    const knownIndexes: number[] = [];
    const knownDirectives: Directive[] = [];
    for (let index = 0; index < section.config.length; index += 1) {
        const line = section.config[index];
        if (isDirective(line) && isOrderedContainerDirective(line)) {
            knownIndexes.push(index);
            knownDirectives.push(line);
        }
    }

    const orderedDirectives: Directive[] = [];
    for (const predicate of ORDERED_CONTAINER_DIRECTIVES) {
        for (const directive of knownDirectives) {
            if (predicate(directive)) {
                orderedDirectives.push(directive);
            }
        }
    }

    for (let index = 0; index < knownIndexes.length; index += 1) {
        const targetIndex = knownIndexes[index];
        const directive = orderedDirectives[index];
        if (section.config[targetIndex] !== directive) {
            section.config[targetIndex] = directive;
            changed = true;
        }
    }
    return changed;
}

function createDirective(param: string, value: string, before: string): Directive {
    return {
        type: SSHConfig.DIRECTIVE,
        param,
        separator: ' ',
        value,
        before,
        after: '\n',
    };
}

function insertDirective(config: SSHConfig, index: number, directive: { param: string; value: string }): boolean {
    const insertionIndex = index >= 0 ? index : config.length;
    const template = config.find(isDirective);
    const before = template?.before && /^[ \t]+$/.test(template.before) ? template.before : '\t';
    config.splice(insertionIndex, 0, createDirective(directive.param, directive.value, before));
    return true;
}

function setDirective(
    config: SSHConfig,
    predicate: (line: Directive) => boolean,
    canonicalParam: string,
    value: string,
    insertBeforeCustom = false,
): boolean {
    const indexes = config
        .map((line, index) => isDirective(line) && predicate(line) ? index : -1)
        .filter(index => index >= 0);
    if (!indexes.length) {
        const index = insertBeforeCustom ? config.findIndex(line => isCustomDirective(line)) : findExpiresInsertionIndex(config);
        return insertDirective(config, index, { param: canonicalParam, value });
    }

    let changed = false;
    const first = config[indexes[0]] as Directive;
    if (directiveValue(first) !== value) {
        first.value = value;
        changed = true;
    }
    for (let index = indexes.length - 1; index > 0; index -= 1) {
        config.splice(indexes[index], 1);
        changed = true;
    }
    return changed;
}

function removeDirectives(config: SSHConfig, predicate: (line: Directive) => boolean): boolean {
    let changed = false;
    for (let index = config.length - 1; index >= 0; index -= 1) {
        if (isDirective(config[index]) && predicate(config[index] as Directive)) {
            config.splice(index, 1);
            changed = true;
        }
    }
    return changed;
}

function findExpiresInsertionIndex(config: SSHConfig): number {
    const containerIdIndex = config.findIndex(line => isDirective(line) && isContainerIdDirective(line as Directive));
    return containerIdIndex >= 0 ? containerIdIndex + 1 : config.length;
}

function getFirstCustomDirective(config: SSHConfig): Line | undefined {
    return config.find(line => isDirective(line) && isCustomDirective(line));
}

function findContainerSection(config: SSHConfig, containerId: string): Section | undefined {
    return config.find(line => isHostSection(line) && sectionHasContainerId(line, containerId)) as Section | undefined;
}

function sectionHasContainerId(section: Section, containerId: string): boolean {
    return getDirectiveValue(section.config, isContainerIdDirective) === containerId;
}

function getDirectiveValue(config: SSHConfig, predicate: (line: Directive) => boolean): string | undefined {
    const directive = config.find(line => isDirective(line) && predicate(line)) as Directive | undefined;
    if (!directive) {
        return undefined;
    }
    const value = directiveValue(directive).trim();
    return value || undefined;
}

function getHostValue(section: Section): string {
    if (typeof section.value === 'string') {
        return section.value;
    }
    return section.value.map(value => value.val).join(' ');
}

function directiveValue(directive: Directive): string {
    return typeof directive.value === 'string'
        ? directive.value
        : directive.value.map(value => value.val).join(' ');
}

function findDirective(config: SSHConfig, predicate: (line: Directive) => boolean): Directive | undefined {
    return config.find(line => isDirective(line) && predicate(line)) as Directive | undefined;
}

function isHostSection(line: Line): line is Section {
    return isDirective(line) && /^host$/i.test(line.param) && 'config' in line;
}

function isDirective(line: Line): line is Directive {
    return line.type === SSHConfig.DIRECTIVE;
}

function isCustomDirective(line: Line | Directive): boolean {
    return isDirective(line) && (isContainerIdDirective(line) || isExpiresAtDirective(line));
}

function isContainerIdDirective(line: Directive): boolean {
    return /^containerid$/i.test(line.param);
}

function isHostNameDirective(line: Directive): boolean {
    return /^hostname$/i.test(line.param);
}

function isUserDirective(line: Directive): boolean {
    return /^user$/i.test(line.param);
}

function isUserKnownHostsFileDirective(line: Directive): boolean {
    return /^userknownhostsfile$/i.test(line.param);
}

function isPortDirective(line: Directive): boolean {
    return /^port$/i.test(line.param);
}

function isExpiresAtDirective(line: Directive): boolean {
    return /^expiresat$/i.test(line.param);
}

function isIgnoreUnknownDirective(line: Directive): boolean {
    return /^ignoreunknown$/i.test(line.param);
}

function isSkipKnownHostsDirective(line: Directive): boolean {
    return /^stricthostkeychecking$/i.test(line.param);
}

const ORDERED_CONTAINER_DIRECTIVES: Array<(line: Directive) => boolean> = [
    isHostNameDirective,
    isUserDirective,
    isPortDirective,
    isSkipKnownHostsDirective,
    isUserKnownHostsFileDirective,
    isIgnoreUnknownDirective,
    isContainerIdDirective,
    isExpiresAtDirective,
];

function isOrderedContainerDirective(line: Directive): boolean {
    return ORDERED_CONTAINER_DIRECTIVES.some(predicate => predicate(line));
}

function getErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return undefined;
}

function resolveConfiguredPath(configuredPath: string): string {
    const resolvedPath = path.resolve(expandPath(configuredPath));
    try {
        if (fs.statSync(resolvedPath).isDirectory()) {
            return path.join(resolvedPath, DIRECTORY_CONFIG_FILE);
        }
    } catch {
        // A missing path is the normal case; ContainerConfig creates its parent/file later.
    }
    return resolvedPath;
}

function parsePort(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value)) {
        return undefined;
    }
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

async function unlinkIfPresent(fileSystem: ContainerConfigFileSystem, filePath: string): Promise<void> {
    try {
        await fileSystem.unlink(filePath);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            throw error;
        }
    }
}

const nodeFileSystem: ContainerConfigFileSystem = {
    mkdir: async (directory, options) => {
        await fs.promises.mkdir(directory, options);
    },
    readFile: filePath => fs.promises.readFile(filePath, 'utf8'),
    writeFile: async (filePath, content, options) => {
        await fs.promises.writeFile(filePath, content, options);
    },
    rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
    unlink: filePath => fs.promises.unlink(filePath),
};
