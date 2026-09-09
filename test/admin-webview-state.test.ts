import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADMIN_WEBVIEW_SCRIPT } from '../src/adminWebview/script';

interface FakeOption {
    value: string;
}

interface MessageEvent {
    data: unknown;
}

type DocumentEventListener = (event: { target: FakeElement }) => void;
type WindowEventListener = (event: MessageEvent) => void;

class FakeClassList {
    private readonly values = new Set<string>();

    public contains(value: string): boolean {
        return this.values.has(value);
    }

    public add(value: string): void {
        this.values.add(value);
    }

    public remove(value: string): void {
        this.values.delete(value);
    }
}

class FakeElement {
    public readonly children: FakeElement[] = [];
    public readonly classList = new FakeClassList();
    public readonly options: FakeOption[] = [];
    public parent: FakeElement | undefined;
    public hidden = false;
    public disabled = false;
    public open = false;
    public checked = false;
    public value = '';
    public type = '';
    public textContent = '';
    public selectionStart: number | null = null;
    public selectionEnd: number | null = null;
    public selectionDirection = 'none';

    public constructor(
        private readonly tagName: string,
        private readonly attributes: Record<string, string> = {},
    ) {
        this.value = attributes.value ?? '';
        this.type = attributes.type ?? '';
        this.open = 'open' in attributes;
        this.checked = 'checked' in attributes;
        (attributes.class ?? '').split(/\s+/).filter(Boolean).forEach(value => this.classList.add(value));
    }

    public appendChild(child: FakeElement): FakeElement {
        child.parent = this;
        this.children.push(child);
        if (this.tagName === 'select' && child.tagName === 'option') {
            this.options.push({ value: child.value });
        }
        return child;
    }

    public getAttribute(name: string): string | null {
        return name in this.attributes ? this.attributes[name] : null;
    }

    public setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
    }

    public removeAttribute(name: string): void {
        delete this.attributes[name];
    }

    public matches(selector: string): boolean {
        return selector.split(',').some(part => this.matchesSelector(part.trim()));
    }

    public closest(selector: string): FakeElement | null {
        if (this.matches(selector)) {
            return this;
        }
        let current = this.parent;
        while (current) {
            if (current.matches(selector)) {
                return current;
            }
            current = current.parent;
        }
        return null;
    }

    public querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    public querySelectorAll(selector: string): FakeElement[] {
        const matches: FakeElement[] = [];
        const visit = (element: FakeElement): void => {
            element.children.forEach(child => {
                if (child.matches(selector)) {
                    matches.push(child);
                }
                visit(child);
            });
        };
        visit(this);
        return matches;
    }

    public focus(): void {
        let root = this.parent;
        while (root?.parent) {
            root = root.parent;
        }
        if (root instanceof FakeDocument) {
            root.activeElement = this;
        }
    }

    public setSelectionRange(start: number, end: number, direction = 'none'): void {
        this.selectionStart = start;
        this.selectionEnd = end;
        this.selectionDirection = direction;
    }

    public get dataset(): Record<string, string> {
        return Object.fromEntries(Object.entries(this.attributes)
            .filter(([name]) => name.startsWith('data-'))
            .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value]));
    }

    private matchesSimpleSelector(selector: string): boolean {
        let value = selector;
        const checked = value.endsWith(':checked');
        if (checked) {
            value = value.slice(0, -':checked'.length);
        }
        const classMatch = /\.([\w-]+)/.exec(value);
        if (classMatch && !this.classList.contains(classMatch[1])) {
            return false;
        }
        const tagMatch = /^([a-z]+)/i.exec(value);
        if (tagMatch && this.tagName !== tagMatch[1].toLowerCase()) {
            return false;
        }
        const attributeMatches = value.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g);
        for (const match of attributeMatches) {
            const attribute = this.getAttribute(match[1]);
            if (attribute === null || match[2] !== undefined && attribute !== match[2]) {
                return false;
            }
        }
        return (!checked || this.checked) && Boolean(classMatch || tagMatch || value.includes('['));
    }

    private matchesSelector(selector: string): boolean {
        const parts = selector.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
            return this.matchesSimpleSelector(parts[0]);
        }
        if (!this.matchesSimpleSelector(parts[parts.length - 1])) {
            return false;
        }
        let ancestor = this.parent;
        for (let index = parts.length - 2; index >= 0; index -= 1) {
            while (ancestor && !ancestor.matchesSimpleSelector(parts[index])) {
                ancestor = ancestor.parent;
            }
            if (!ancestor) {
                return false;
            }
            ancestor = ancestor.parent;
        }
        return true;
    }
}

class FakeDocument extends FakeElement {
    private readonly listeners = new Map<string, DocumentEventListener[]>();
    public activeElement: FakeElement | undefined;

    public constructor() {
        super('#document');
    }

    public createElement(tagName: string): FakeElement {
        return new FakeElement(tagName);
    }

    public addEventListener(type: string, listener: DocumentEventListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    public dispatch(type: string, target: FakeElement): void {
        this.listeners.get(type)?.forEach(listener => listener({ target }));
    }
}

interface ScriptRuntime {
    getState: () => Record<string, unknown>;
    messages: unknown[];
    dispatchMessage: (data: unknown) => void;
}

function runScript(document: FakeDocument, initialState: Record<string, unknown>): ScriptRuntime {
    let state = initialState;
    const messages: unknown[] = [];
    const windowListeners: WindowEventListener[] = [];
    new Script(ADMIN_WEBVIEW_SCRIPT).runInNewContext({
        acquireVsCodeApi: () => ({
            getState: () => state,
            setState: (next: Record<string, unknown>) => { state = next; },
            postMessage: (message: unknown) => { messages.push(message); },
        }),
        document,
        window: {
            addEventListener: (type: string, listener: WindowEventListener) => {
                if (type === 'message') {
                    windowListeners.push(listener);
                }
            },
        },
    });
    return {
        getState: () => state,
        messages,
        dispatchMessage: data => windowListeners.forEach(listener => listener({ data })),
    };
}

function createFormDocument(imageValues: string[] = ['image-1', 'image-2']): {
    document: FakeDocument;
    userId: FakeElement;
    fullUrl: FakeElement;
    giteeModeNone: FakeElement;
    giteeModeFull: FakeElement;
    giteeModeParts: FakeElement;
    giteeUser: FakeElement;
    autoPush: FakeElement;
    image: FakeElement;
    imageLabel: FakeElement;
    imageTrigger: FakeElement;
    whitelistUserId: FakeElement;
} {
    const document = new FakeDocument();
    const form = new FakeElement('div', { 'data-form': 'createContainer' });
    const userId = new FakeElement('input', { 'data-field': 'user_id', 'data-persist-key': 'create.user_id', type: 'text' });
    const giteeModeNone = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'none', type: 'radio', checked: '' });
    const giteeModeFull = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'full', type: 'radio' });
    const giteeModeParts = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'parts', type: 'radio' });
    const fullPanel = new FakeElement('div', { 'data-gitee-mode-panel': 'full' });
    const fullUrl = new FakeElement('input', { 'data-field': 'gitee_full_url', 'data-persist-key': 'create.gitee_full_url', type: 'text' });
    const partsPanel = new FakeElement('div', { 'data-gitee-mode-panel': 'parts' });
    const giteeUser = new FakeElement('input', { 'data-field': 'gitee_user', 'data-persist-key': 'create.gitee_user', type: 'text', disabled: '' });
    const autoPush = new FakeElement('input', { 'data-field': 'autoPush', 'data-persist-key': 'upload.autoPush', type: 'checkbox', checked: '' });
    const imageWrapper = new FakeElement('span', { 'data-custom-select': '', class: 'custom-select' });
    const imageLabel = new FakeElement('span', { 'data-select-label': '' });
    const imageTrigger = new FakeElement('button', { 'data-select-trigger': '' });
    const image = new FakeElement('select', { 'data-field': 'image', 'data-persist-key': 'create.image', value: 'image-1' });
    const imageMenu = new FakeElement('span', { 'data-select-menu': '' });
    image.options.push(...imageValues.map(value => ({ value })));
    const whitelistForm = new FakeElement('div', { 'data-form': 'whitelistUser' });
    const whitelistUserId = new FakeElement('input', { 'data-field': 'user_id', 'data-persist-key': 'whitelist.user_id', type: 'text' });

    fullPanel.appendChild(fullUrl);
    partsPanel.appendChild(giteeUser);
    form.appendChild(userId);
    form.appendChild(giteeModeNone);
    form.appendChild(giteeModeFull);
    form.appendChild(fullPanel);
    form.appendChild(giteeModeParts);
    form.appendChild(partsPanel);
    form.appendChild(autoPush);
    imageValues.forEach(value => imageMenu.appendChild(new FakeElement('button', { 'data-select-option': '', 'data-select-value': value })));
    imageWrapper.appendChild(imageLabel);
    imageWrapper.appendChild(imageTrigger);
    imageWrapper.appendChild(image);
    imageWrapper.appendChild(imageMenu);
    form.appendChild(imageWrapper);
    whitelistForm.appendChild(whitelistUserId);
    document.appendChild(form);
    document.appendChild(whitelistForm);
    return { document, userId, fullUrl, giteeModeNone, giteeModeFull, giteeModeParts, giteeUser, autoPush, image, imageLabel, imageTrigger, whitelistUserId };
}

function createLogDocument(): {
    document: FakeDocument;
    modal: FakeElement;
    title: FakeElement;
    content: FakeElement;
    logButton: FakeElement;
    closeButton: FakeElement;
} {
    const document = new FakeDocument();
    const row = new FakeElement('article', { class: 'resource-row' });
    const logButton = new FakeElement('button', { 'data-action': 'getContainerLog', 'data-container-id': 'container-1' });
    const modal = new FakeElement('div', { 'data-log-modal': '' });
    const title = new FakeElement('strong', { 'data-log-title': '' });
    const content = new FakeElement('pre', { 'data-log-content': '' });
    const refreshButton = new FakeElement('button', { 'data-action': 'getContainerLog', 'data-container-id': '', 'data-log-refresh': '' });
    const closeButton = new FakeElement('button', { 'data-action': 'closeContainerLog' });
    modal.hidden = true;
    row.appendChild(logButton);
    modal.appendChild(title);
    modal.appendChild(content);
    modal.appendChild(refreshButton);
    modal.appendChild(closeButton);
    document.appendChild(row);
    document.appendChild(modal);
    return { document, modal, title, content, logButton, closeButton };
}

function createCollapsibleDocument(): { document: FakeDocument; uploadCard: FakeElement; createCard: FakeElement } {
    const document = new FakeDocument();
    const uploadCard = new FakeElement('details', { 'data-form': 'uploadImage', open: '' });
    const createCard = new FakeElement('details', { 'data-form': 'createContainer', open: '' });
    document.appendChild(uploadCard);
    document.appendChild(createCard);
    return { document, uploadCard, createCard };
}

describe('Admin Webview state', () => {
    it('restores every form control after the host replaces the page HTML', () => {
        const first = createFormDocument();
        const firstRuntime = runScript(first.document, {});

        first.userId.value = 'user-1';
        first.document.dispatch('input', first.userId);
        first.fullUrl.value = 'https://gitee.com/alice/repo';
        first.document.dispatch('input', first.fullUrl);
        first.giteeModeNone.checked = false;
        first.giteeModeFull.checked = false;
        first.giteeModeParts.checked = true;
        first.giteeUser.disabled = false;
        first.giteeUser.value = 'alice';
        first.document.dispatch('change', first.giteeModeParts);
        first.document.dispatch('input', first.giteeUser);
        first.autoPush.checked = false;
        first.document.dispatch('change', first.autoPush);
        first.image.value = 'image-2';
        first.document.dispatch('change', first.image);
        first.whitelistUserId.value = 'user-2';
        first.document.dispatch('input', first.whitelistUserId);
        first.document.activeElement = first.giteeUser;
        first.giteeUser.selectionStart = 2;
        first.giteeUser.selectionEnd = 5;
        first.giteeUser.selectionDirection = 'forward';
        first.document.dispatch('select', first.giteeUser);

        expect(firstRuntime.getState()).toMatchObject({
            fields: {
                'create.user_id': 'user-1',
                'create.gitee_full_url': 'https://gitee.com/alice/repo',
                'create.giteeMode': 'parts',
                'create.gitee_user': 'alice',
                'upload.autoPush': false,
                'create.image': 'image-2',
                'whitelist.user_id': 'user-2',
            },
        });

        const second = createFormDocument(['image-1']);
        runScript(second.document, firstRuntime.getState());

        expect(second.userId.value).toBe('user-1');
        expect(second.fullUrl.value).toBe('https://gitee.com/alice/repo');
        expect(second.giteeModeFull.checked).toBe(false);
        expect(second.giteeModeParts.checked).toBe(true);
        expect(second.giteeUser.value).toBe('alice');
        expect(second.giteeUser.disabled).toBe(false);
        expect(second.document.activeElement).toBe(second.giteeUser);
        expect(second.giteeUser.selectionStart).toBe(2);
        expect(second.giteeUser.selectionEnd).toBe(5);
        expect(second.giteeUser.selectionDirection).toBe('forward');
        expect(second.autoPush.checked).toBe(false);
        expect(second.image.value).toBe('image-2');
        expect(second.imageLabel.textContent).toBe('image-2');
        expect(second.whitelistUserId.value).toBe('user-2');
    });

    it('notifies the host while a custom image selector is open', () => {
        const document = createFormDocument();
        const runtime = runScript(document.document, {});

        document.document.dispatch('click', document.imageTrigger);
        document.document.dispatch('click', document.imageTrigger);

        expect(runtime.messages).toEqual([
            { command: 'ready' },
            { command: 'setSelectOpen', open: true },
            { command: 'setSelectOpen', open: false },
        ]);
    });

    it('does not restore a focus that was released before the page refreshes', () => {
        const first = createFormDocument();
        const firstRuntime = runScript(first.document, {});

        first.userId.focus();
        first.document.dispatch('focusin', first.userId);
        expect(firstRuntime.getState()).toMatchObject({ focus: { key: 'field.create.user_id' } });

        first.document.activeElement = undefined;
        first.document.dispatch('focusout', first.userId);
        expect(firstRuntime.getState()).not.toHaveProperty('focus');

        const second = createFormDocument();
        runScript(second.document, firstRuntime.getState());

        expect(second.document.activeElement).toBeUndefined();
    });

    it('restores collapsible card states after the host replaces the page HTML', () => {
        const first = createCollapsibleDocument();
        const firstRuntime = runScript(first.document, {});

        first.uploadCard.open = false;
        first.document.dispatch('toggle', first.uploadCard);
        first.createCard.open = false;
        first.document.dispatch('toggle', first.createCard);

        expect(firstRuntime.getState()).toMatchObject({
            collapsible: {
                uploadImage: false,
                createContainer: false,
            },
        });

        const second = createCollapsibleDocument();
        runScript(second.document, firstRuntime.getState());

        expect(second.uploadCard.open).toBe(false);
        expect(second.createCard.open).toBe(false);
    });

    it('keeps the log modal open and reloads its content after the page HTML is replaced', () => {
        const first = createLogDocument();
        const firstRuntime = runScript(first.document, {});
        first.document.dispatch('click', first.logButton);

        expect(first.modal.hidden).toBe(false);
        expect(first.title.textContent).toBe('container-1');
        expect(firstRuntime.getState()).toMatchObject({ log: { open: true, containerId: 'container-1' } });

        firstRuntime.dispatchMessage({ command: 'containerLog', containerId: 'container-1', log: 'first log' });
        expect(first.content.textContent).toBe('first log');

        const second = createLogDocument();
        const secondRuntime = runScript(second.document, firstRuntime.getState());

        expect(second.modal.hidden).toBe(false);
        expect(second.title.textContent).toBe('container-1');
        expect(second.content.textContent).toBe('正在加载日志...');
        expect(secondRuntime.messages).toContainEqual({ command: 'getContainerLog', containerId: 'container-1' });

        secondRuntime.dispatchMessage({ command: 'containerLog', containerId: 'container-1', log: 'latest log' });
        expect(second.content.textContent).toBe('latest log');
        second.document.dispatch('click', second.closeButton);
        expect(second.modal.hidden).toBe(true);
        expect(secondRuntime.getState()).toMatchObject({ log: { open: false, containerId: 'container-1' } });
        secondRuntime.dispatchMessage({ command: 'containerLog', containerId: 'container-1', log: 'stale log' });
        expect(second.modal.hidden).toBe(true);
    });
});
