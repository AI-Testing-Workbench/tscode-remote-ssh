import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADMIN_WEBVIEW_SCRIPT } from '../src/adminWebview/script';

interface FakeOption {
    value: string;
    textContent?: string;
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

    public toggle(value: string, force?: boolean): boolean {
        const enabled = force ?? !this.values.has(value);
        if (enabled) {
            this.values.add(value);
        } else {
            this.values.delete(value);
        }
        return enabled;
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

    public dispatchEvent(): boolean {
        dispatchChange(this);
        return true;
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

    public setCustomValidity(): void {}

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

function dispatchChange(element: FakeElement): void {
    let parent = element.parent;
    while (parent) {
        if (parent instanceof FakeDocument) {
            parent.dispatch('change', element);
            return;
        }
        parent = parent.parent;
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
        Event,
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

function createFormDocument(imageValues: string[] = ['image-1', 'image-2', 'image-3'], cpuDefault = '2', memoryDefault = '4'): {
    document: FakeDocument;
    userId: FakeElement;
    giteeModeFrom: FakeElement;
    giteeModeReplace: FakeElement;
    fullUrl: FakeElement;
    giteeModeNone: FakeElement;
    giteeModeFull: FakeElement;
    giteeModeParts: FakeElement;
    from: FakeElement;
    replace: FakeElement;
    giteeUser: FakeElement;
    branchRow: FakeElement;
    giteeBranch: FakeElement;
    authorize: FakeElement;
    skipGit: FakeElement;
    cpu: FakeElement;
    memory: FakeElement;
    autoPush: FakeElement;
    containerType: FakeElement;
    image: FakeElement;
    imageWrapper: FakeElement;
    imageLabel: FakeElement;
    imageTrigger: FakeElement;
    imageSearchInput: FakeElement;
    imageSearchEmpty: FakeElement;
    imageOptions: FakeElement[];
    outside: FakeElement;
    submitLabel: FakeElement;
    whitelistUserId: FakeElement;
    autoTestId: FakeElement;
    sourceBusinessId: FakeElement;
    taskType: FakeElement;
    taskTypeDescription: FakeElement;
    taskFieldsRow: FakeElement;
    defaultImageHint: FakeElement;
    createButton: FakeElement;
} {
    const document = new FakeDocument();
    const form = new FakeElement('div', { 'data-form': 'createContainer' });
    const userId = new FakeElement('input', { 'data-field': 'user_id', 'data-persist-key': 'create.user_id', type: 'text' });
    const giteeModeFrom = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'from', type: 'radio' });
    const giteeModeReplace = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'replace', type: 'radio' });
    const giteeModeNone = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'none', type: 'radio', checked: '' });
    const giteeModeFull = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'full', type: 'radio' });
    const giteeModeParts = new FakeElement('input', { 'data-field': 'giteeMode', 'data-persist-key': 'create.giteeMode', value: 'parts', type: 'radio' });
    const fromPanel = new FakeElement('div', { 'data-gitee-mode-panel': 'from' });
    const from = new FakeElement('input', { 'data-field': 'from', 'data-persist-key': 'create.from', type: 'text', disabled: '' });
    const replacePanel = new FakeElement('div', { 'data-gitee-mode-panel': 'replace' });
    const replace = new FakeElement('input', { 'data-field': 'replace', 'data-persist-key': 'create.replace', type: 'text', disabled: '' });
    const fullPanel = new FakeElement('div', { 'data-gitee-mode-panel': 'full' });
    const fullUrl = new FakeElement('input', { 'data-field': 'gitee_full_url', 'data-persist-key': 'create.gitee_full_url', type: 'text' });
    const partsPanel = new FakeElement('div', { 'data-gitee-mode-panel': 'parts' });
    const giteeUser = new FakeElement('input', { 'data-field': 'gitee_user', 'data-persist-key': 'create.gitee_user', type: 'text', disabled: '' });
    const branchRow = new FakeElement('div', { class: 'form-row two-fields branch-row' });
    const giteeBranch = new FakeElement('input', { 'data-field': 'gitee_branch', 'data-gitee-dependent': '', 'data-persist-key': 'create.gitee_branch', type: 'text', disabled: '' });
    const authorize = new FakeElement('input', { 'data-field': 'authorize_general_account', 'data-gitee-dependent': '', 'data-persist-key': 'create.authorize_general_account', type: 'checkbox', disabled: '' });
    const skipGit = new FakeElement('input', { 'data-field': 'skip_git', 'data-persist-key': 'create.skip_git', type: 'checkbox' });
    const cpu = new FakeElement('input', { 'data-field': 'cpu', 'data-persist-key': 'create.cpu', 'data-default-value': cpuDefault, type: 'number', value: cpuDefault });
    const memory = new FakeElement('input', { 'data-field': 'memory', 'data-persist-key': 'create.memory', 'data-default-value': memoryDefault, type: 'number', value: memoryDefault });
    const autoPush = new FakeElement('input', { 'data-field': 'autoPush', 'data-persist-key': 'upload.autoPush', type: 'checkbox', checked: '' });
    const containerType = new FakeElement('select', {
        'data-field': 'type',
        'data-persist-key': 'create.type',
        type: 'select-one',
        value: 'testagent_cloud',
    });
    containerType.options.push(
        { value: 'testagent_cloud' },
        { value: 'testagent_cloud_chrome' },
        { value: 'evaluation_cloud' },
        { value: 'autotest_cloud' },
    );
    const imageWrapper = new FakeElement('span', { 'data-custom-select': '', class: 'custom-select' });
    const imageLabel = new FakeElement('span', { 'data-select-label': '' });
    const imageTrigger = new FakeElement('button', { 'data-select-trigger': '' });
    const submitLabel = new FakeElement('span', { 'data-create-submit-label': '' });
    const defaultImages = {
        testagent_cloud: 'image-1',
        evaluation_cloud: 'image-3',
        autotest_cloud: 'image-2',
    };
    const image = new FakeElement('select', {
        class: 'native-select',
        'data-field': 'image',
        'data-persist-key': 'create.image',
        'data-default-value': 'image-1',
        'data-default-images': JSON.stringify(defaultImages),
        'data-default-image-fallback': '',
        'data-listed-default-images': JSON.stringify(Object.values(defaultImages)),
        value: 'image-1',
    });
    const imageMenu = new FakeElement('span', { 'data-select-menu': '' });
    const imageSearchInput = new FakeElement('input', { 'data-select-search': '', type: 'search' });
    const imageSearchEmpty = new FakeElement('span', { 'data-select-search-empty': '' });
    imageSearchEmpty.hidden = true;
    const imageOptions = imageValues.map(value => new FakeElement('button', {
        'data-select-option': '',
        'data-select-value': value,
        'data-select-search-text': value,
    }));
    imageOptions.forEach(option => { option.textContent = option.getAttribute('data-select-value') ?? ''; });
    image.options.push(...imageValues.map(value => ({ value, textContent: value })));
    const defaultImageHint = new FakeElement('small', { 'data-default-image-hint': '' });
    const taskFieldsRow = new FakeElement('div', { 'data-task-fields-row': '', class: 'task-fields-row task-fields-disabled' });
    const autoTestId = new FakeElement('input', { 'data-field': 'auto_test_id', 'data-persist-key': 'create.auto_test_id', type: 'text', disabled: '' });
    const sourceBusinessId = new FakeElement('input', { 'data-field': 'source_business_id', 'data-persist-key': 'create.source_business_id', type: 'text', disabled: '' });
    const taskType = new FakeElement('input', {
        'data-field': 'task_type',
        'data-persist-key': 'create.task_type',
        'data-task-type-descriptions': JSON.stringify({
            0: '低码自动化任务',
            1: '低码自动化重跑任务',
            2: '并发执行集任务',
            3: '移动端执行集任务',
            4: '高码自动化任务',
            5: '移动端重跑任务',
            6: '高码自动化重跑任务',
        }),
        type: 'number',
        disabled: '',
    });
    const taskTypeDescription = new FakeElement('small', { 'data-task-type-description': '' });
    taskTypeDescription.hidden = true;
    taskFieldsRow.appendChild(autoTestId);
    taskFieldsRow.appendChild(sourceBusinessId);
    taskFieldsRow.appendChild(taskType);
    taskFieldsRow.appendChild(taskTypeDescription);
    const createButton = new FakeElement('button', { 'data-action': 'createContainer' });
    const whitelistForm = new FakeElement('div', { 'data-form': 'whitelistUser' });
    const whitelistUserId = new FakeElement('input', { 'data-field': 'user_id', 'data-persist-key': 'whitelist.user_id', type: 'text' });
    const outside = new FakeElement('button');
    imageOptions[1]?.setAttribute('data-select-search-text', `${imageValues[1]} (默认镜像)`);

    fromPanel.appendChild(from);
    replacePanel.appendChild(replace);
    fullPanel.appendChild(fullUrl);
    partsPanel.appendChild(giteeUser);
    branchRow.appendChild(giteeBranch);
    branchRow.appendChild(authorize);
    form.appendChild(userId);
    form.appendChild(giteeModeFrom);
    form.appendChild(fromPanel);
    form.appendChild(giteeModeReplace);
    form.appendChild(replacePanel);
    form.appendChild(giteeModeNone);
    form.appendChild(giteeModeFull);
    form.appendChild(fullPanel);
    form.appendChild(giteeModeParts);
    form.appendChild(partsPanel);
    form.appendChild(branchRow);
    form.appendChild(containerType);
    form.appendChild(taskFieldsRow);
    form.appendChild(skipGit);
    form.appendChild(cpu);
    form.appendChild(memory);
    form.appendChild(autoPush);
    imageMenu.appendChild(imageSearchInput);
    imageMenu.appendChild(imageSearchEmpty);
    imageOptions.forEach(option => imageMenu.appendChild(option));
    imageWrapper.appendChild(imageLabel);
    imageWrapper.appendChild(imageTrigger);
    imageWrapper.appendChild(image);
    imageWrapper.appendChild(imageMenu);
    form.appendChild(imageWrapper);
    form.appendChild(defaultImageHint);
    form.appendChild(createButton);
    form.appendChild(submitLabel);
    whitelistForm.appendChild(whitelistUserId);
    document.appendChild(form);
    document.appendChild(whitelistForm);
    document.appendChild(outside);
    return {
        document,
        userId,
        giteeModeFrom,
        giteeModeReplace,
        fullUrl,
        giteeModeNone,
        giteeModeFull,
        giteeModeParts,
        from,
        replace,
        giteeUser,
        branchRow,
        giteeBranch,
        authorize,
        skipGit,
        cpu,
        memory,
        autoPush,
        containerType,
        image,
        imageWrapper,
        imageLabel,
        imageTrigger,
        imageSearchInput,
        imageSearchEmpty,
        imageOptions,
        outside,
        submitLabel,
        whitelistUserId,
        autoTestId,
        sourceBusinessId,
        taskType,
        taskTypeDescription,
        taskFieldsRow,
        defaultImageHint,
        createButton,
    };
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
    const logButton = new FakeElement('button', { 'data-action': 'getContainerLog', 'data-service-id': 'service-1' });
    const modal = new FakeElement('div', { 'data-log-modal': '' });
    const title = new FakeElement('strong', { 'data-log-title': '' });
    const content = new FakeElement('pre', { 'data-log-content': '' });
    const refreshButton = new FakeElement('button', { 'data-action': 'getContainerLog', 'data-service-id': '', 'data-log-refresh': '' });
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

    it('enables repository fields only for Gitee binding modes', () => {
        const form = createFormDocument();
        const runtime = runScript(form.document, {});
        expect(form.defaultImageHint.textContent).toBe('');

        expect(form.from.disabled).toBe(true);
        expect(form.giteeBranch.disabled).toBe(true);
        expect(form.authorize.disabled).toBe(true);
        expect(form.branchRow.classList.contains('gitee-options-disabled')).toBe(true);

        form.giteeModeNone.checked = false;
        form.giteeModeFrom.checked = true;
        form.document.dispatch('change', form.giteeModeFrom);
        expect(form.from.disabled).toBe(false);
        expect(form.giteeBranch.disabled).toBe(true);
        expect(form.authorize.disabled).toBe(true);
        expect(form.branchRow.classList.contains('gitee-options-disabled')).toBe(true);
        form.from.value = 'source-service-1';
        form.document.dispatch('input', form.from);
        form.skipGit.checked = true;
        form.document.dispatch('change', form.skipGit);

        const restored = createFormDocument();
        runScript(restored.document, runtime.getState());
        expect(restored.giteeModeFrom.checked).toBe(true);
        expect(restored.from.value).toBe('source-service-1');
        expect(restored.skipGit.checked).toBe(true);
        expect(restored.giteeBranch.disabled).toBe(true);
        expect(restored.authorize.disabled).toBe(true);

        form.giteeModeFrom.checked = false;
        form.giteeModeParts.checked = true;
        form.document.dispatch('change', form.giteeModeParts);
        expect(form.from.disabled).toBe(true);
        expect(form.giteeBranch.disabled).toBe(false);
        expect(form.authorize.disabled).toBe(false);
        expect(form.branchRow.classList.contains('gitee-options-disabled')).toBe(false);

        form.giteeModeParts.checked = false;
        form.giteeModeNone.checked = true;
        form.document.dispatch('change', form.giteeModeNone);
        expect(form.giteeBranch.disabled).toBe(true);
        expect(form.authorize.disabled).toBe(true);
        expect(form.branchRow.classList.contains('gitee-options-disabled')).toBe(true);

        form.giteeModeNone.checked = false;
        form.giteeModeReplace.checked = true;
        form.document.dispatch('change', form.giteeModeReplace);
        expect(form.replace.disabled).toBe(false);
        expect(form.from.disabled).toBe(true);
        expect(form.giteeBranch.disabled).toBe(true);
        expect(form.authorize.disabled).toBe(true);
        expect(form.submitLabel.textContent).toBe('替换服务');

        form.replace.value = 'target-service-1';
        form.document.dispatch('input', form.replace);
        const restoredReplace = createFormDocument();
        runScript(restoredReplace.document, runtime.getState());
        expect(restoredReplace.giteeModeReplace.checked).toBe(true);
        expect(restoredReplace.replace.value).toBe('target-service-1');
        expect(restoredReplace.replace.disabled).toBe(false);
        expect(restoredReplace.submitLabel.textContent).toBe('替换服务');
    });

    it('uses updated global limits for untouched defaults and preserves edited values', () => {
        const initial = createFormDocument(undefined, '2', '4');
        const initialRuntime = runScript(initial.document, {
            fields: { 'create.cpu': '', 'create.memory': '' },
        });
        expect(initial.cpu.value).toBe('2');
        expect(initial.memory.value).toBe('4');

        const updatedDefaults = createFormDocument(undefined, '3', '8');
        const updatedRuntime = runScript(updatedDefaults.document, initialRuntime.getState());
        expect(updatedDefaults.cpu.value).toBe('3');
        expect(updatedDefaults.memory.value).toBe('8');

        updatedDefaults.cpu.value = '1.5';
        updatedDefaults.document.dispatch('input', updatedDefaults.cpu);
        updatedDefaults.memory.value = '';
        updatedDefaults.document.dispatch('input', updatedDefaults.memory);

        const latestDefaults = createFormDocument(undefined, '5', '16');
        runScript(latestDefaults.document, updatedRuntime.getState());
        expect(latestDefaults.cpu.value).toBe('1.5');
        expect(latestDefaults.memory.value).toBe('');
    });

    it('previews the selected type default and retains only deliberate image overrides', () => {
        const form = createFormDocument();
        const runtime = runScript(form.document, {});

        form.containerType.value = 'testagent_cloud_chrome';
        form.document.dispatch('change', form.containerType);
        expect(form.image.value).toBe('image-1');
        expect(runtime.getState().editedFields).not.toHaveProperty('create.image');

        form.containerType.value = 'autotest_cloud';
        form.document.dispatch('change', form.containerType);
        expect(form.image.value).toBe('image-2');
        expect(runtime.getState().editedFields).not.toHaveProperty('create.image');

        const evaluation = createFormDocument();
        const evaluationRuntime = runScript(evaluation.document, {});
        evaluation.containerType.value = 'evaluation_cloud';
        evaluation.document.dispatch('change', evaluation.containerType);
        expect(evaluation.image.value).toBe('image-3');
        expect(evaluationRuntime.getState().editedFields).not.toHaveProperty('create.image');

        form.image.value = 'image-1';
        form.document.dispatch('change', form.image);
        expect(runtime.getState().editedFields).toMatchObject({ 'create.image': true });
        expect(form.defaultImageHint.textContent).toBe('');

        form.containerType.value = 'evaluation_cloud';
        form.document.dispatch('change', form.containerType);
        expect(form.image.value).toBe('image-1');
        expect(runtime.getState().editedFields).toMatchObject({ 'create.image': true });
    });

    it('keeps the legacy image-status fallback as a preview without turning it into an override', () => {
        const form = createFormDocument();
        form.image.setAttribute('data-default-images', JSON.stringify({
            testagent_cloud: '',
            evaluation_cloud: '',
            autotest_cloud: '',
        }));
        form.image.setAttribute('data-default-value', 'image-2');
        form.image.setAttribute('data-default-image-fallback', 'image-2');
        form.image.setAttribute('data-listed-default-images', JSON.stringify(['image-2']));

        const runtime = runScript(form.document, {});

        expect(form.image.value).toBe('image-2');
        expect(runtime.getState().editedFields).not.toHaveProperty('create.image');
        expect(runtime.getState().fields).not.toHaveProperty('create.image');
    });

    it('shows only the required no-default and missing-default messages', () => {
        const noDefault = createFormDocument();
        noDefault.image.setAttribute('data-default-images', JSON.stringify({
            testagent_cloud: '',
            evaluation_cloud: '',
            autotest_cloud: '',
        }));
        noDefault.image.setAttribute('data-default-value', '');
        noDefault.image.setAttribute('data-default-image-fallback', '');
        noDefault.image.setAttribute('data-listed-default-images', '[]');
        runScript(noDefault.document, {});
        expect(noDefault.defaultImageHint.textContent).toContain('尚未配置默认镜像');

        const missingDefault = createFormDocument();
        missingDefault.image.setAttribute('data-default-images', JSON.stringify({
            testagent_cloud: 'missing-image',
            evaluation_cloud: '',
            autotest_cloud: '',
        }));
        missingDefault.image.setAttribute('data-default-value', 'missing-image');
        missingDefault.image.setAttribute('data-default-image-fallback', '');
        missingDefault.image.setAttribute('data-listed-default-images', '[]');
        runScript(missingDefault.document, {});
        expect(missingDefault.defaultImageHint.textContent).toContain('默认镜像未出现在镜像列表中：missing-image');
    });

    it('restores automated task fields, describes task types, and omits disabled fields from submission', () => {
        const first = createFormDocument();
        const firstRuntime = runScript(first.document, {});
        expect(first.autoTestId.disabled).toBe(true);

        first.containerType.value = 'autotest_cloud';
        first.document.dispatch('change', first.containerType);
        expect(first.autoTestId.disabled).toBe(false);
        expect(first.sourceBusinessId.disabled).toBe(false);
        expect(first.taskType.disabled).toBe(false);
        expect(first.image.value).toBe('image-2');

        first.autoTestId.value = 'auto-17';
        first.document.dispatch('input', first.autoTestId);
        first.sourceBusinessId.value = 'business-9';
        first.document.dispatch('input', first.sourceBusinessId);
        first.taskType.value = '0';
        first.document.dispatch('input', first.taskType);
        expect(first.taskTypeDescription.textContent).toBe('低码自动化任务');
        expect(first.taskTypeDescription.hidden).toBe(false);

        const taskTypeDescriptions = [
            ['0', '低码自动化任务'],
            ['1', '低码自动化重跑任务'],
            ['2', '并发执行集任务'],
            ['3', '移动端执行集任务'],
            ['4', '高码自动化任务'],
            ['5', '移动端重跑任务'],
            ['6', '高码自动化重跑任务'],
        ];
        for (const [taskType, expectedDescription] of taskTypeDescriptions) {
            first.taskType.value = taskType;
            first.document.dispatch('input', first.taskType);
            expect(first.taskTypeDescription.textContent).toBe(expectedDescription);
        }

        first.taskType.value = '9';
        first.document.dispatch('input', first.taskType);
        expect(first.taskTypeDescription.textContent).toBe('未知 Task Type');
        first.taskType.value = '1.5';
        first.document.dispatch('input', first.taskType);
        expect(first.taskTypeDescription.textContent).toBe('Task Type 必须是整数');
        first.taskType.value = '';
        first.document.dispatch('input', first.taskType);
        expect(first.taskTypeDescription.hidden).toBe(true);

        first.taskType.value = '0';
        first.document.dispatch('input', first.taskType);
        const restored = createFormDocument();
        const restoredRuntime = runScript(restored.document, firstRuntime.getState());
        expect(restored.containerType.value).toBe('autotest_cloud');
        expect(restored.autoTestId.value).toBe('auto-17');
        expect(restored.sourceBusinessId.value).toBe('business-9');
        expect(restored.taskType.value).toBe('0');
        expect(restored.taskFieldsRow.classList.contains('task-fields-disabled')).toBe(false);
        expect(restored.taskTypeDescription.textContent).toBe('低码自动化任务');

        restored.containerType.value = 'testagent_cloud';
        restored.document.dispatch('change', restored.containerType);
        expect(restored.autoTestId.disabled).toBe(true);
        expect(restored.sourceBusinessId.disabled).toBe(true);
        expect(restored.taskType.disabled).toBe(true);
        restored.document.dispatch('click', restored.createButton);

        const createMessage = restoredRuntime.messages.find(message => (message as { command?: string }).command === 'createContainer');
        expect(createMessage).toMatchObject({
            command: 'createContainer',
            type: 'testagent_cloud',
            image: 'image-1',
            imageOverride: false,
        });
        expect(createMessage).not.toHaveProperty('auto_test_id');
        expect(createMessage).not.toHaveProperty('source_business_id');
        expect(createMessage).not.toHaveProperty('task_type');
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

    it('filters image choices locally, keeps the menu open for search, and clears the query after selection', () => {
        const form = createFormDocument(['registry.test/team/alpha:v1', 'registry.test/team/beta:v2']);
        const runtime = runScript(form.document, {});

        form.document.dispatch('click', form.imageTrigger);
        expect(form.imageTrigger.getAttribute('aria-expanded')).toBe('true');
        expect(form.document.activeElement).toBe(form.imageSearchInput);

        form.imageSearchInput.value = ' ALPHA ';
        form.document.dispatch('input', form.imageSearchInput);
        expect(form.imageOptions.map(option => option.hidden)).toEqual([false, true]);
        expect(form.imageSearchEmpty.hidden).toBe(true);

        form.document.dispatch('click', form.imageSearchInput);
        expect(form.imageTrigger.getAttribute('aria-expanded')).toBe('true');

        form.imageSearchInput.value = '默认镜像';
        form.document.dispatch('input', form.imageSearchInput);
        expect(form.imageOptions.map(option => option.hidden)).toEqual([true, false]);

        form.imageSearchInput.value = 'missing-image';
        form.document.dispatch('input', form.imageSearchInput);
        expect(form.imageOptions.every(option => option.hidden)).toBe(true);
        expect(form.imageSearchEmpty.hidden).toBe(false);

        form.imageSearchInput.value = 'beta';
        form.document.dispatch('input', form.imageSearchInput);
        form.document.dispatch('click', form.imageOptions[1]);

        expect(form.image.value).toBe('registry.test/team/beta:v2');
        expect(form.imageLabel.textContent).toBe('registry.test/team/beta:v2');
        expect(form.imageSearchInput.value).toBe('');
        expect(form.imageOptions.every(option => !option.hidden)).toBe(true);
        expect(form.imageSearchEmpty.hidden).toBe(true);
        expect(form.imageTrigger.getAttribute('aria-expanded')).toBe('false');
        form.document.dispatch('click', form.imageTrigger);
        form.imageSearchInput.value = 'alpha';
        form.document.dispatch('input', form.imageSearchInput);
        form.document.dispatch('click', form.outside);
        expect(form.imageTrigger.getAttribute('aria-expanded')).toBe('false');
        expect(form.imageSearchInput.value).toBe('');
        expect(form.imageOptions.every(option => !option.hidden)).toBe(true);
        expect(runtime.messages).toEqual([
            { command: 'ready' },
            { command: 'setSelectOpen', open: true },
            { command: 'setSelectOpen', open: false },
            { command: 'setSelectOpen', open: true },
            { command: 'setSelectOpen', open: false },
        ]);
        expect(runtime.getState().fields).toMatchObject({ 'create.image': 'registry.test/team/beta:v2' });
        expect(JSON.stringify(runtime.getState())).not.toContain('missing-image');
    });

    it('attaches request IDs to actions and ignores stale completions', () => {
        const document = new FakeDocument();
        const action = new FakeElement('button', { 'data-action': 'refresh' });
        document.appendChild(action);
        const runtime = runScript(document, {});

        document.dispatch('click', action);

        expect(runtime.messages).toContainEqual({ command: 'refresh', requestId: '1' });
        runtime.dispatchMessage({ command: 'operationComplete', action: 'refresh', requestId: 'stale' });
        expect(action.classList.contains('is-loading')).toBe(true);
        runtime.dispatchMessage({ command: 'operationComplete', action: 'refresh', requestId: '1' });
        expect(action.classList.contains('is-loading')).toBe(false);
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
        expect(first.title.textContent).toBe('service-1');
        expect(firstRuntime.getState()).toMatchObject({ log: { open: true, serviceId: 'service-1' } });
        expect(first.logButton.getAttribute('data-service-id')).toBe('service-1');
        expect(firstRuntime.messages).toContainEqual(expect.objectContaining({ command: 'getContainerLog', serviceId: 'service-1' }));

        firstRuntime.dispatchMessage({ command: 'containerLog', serviceId: 'container-1', log: 'physical ID must not match' });
        expect(first.content.textContent).toBe('正在加载日志...');
        firstRuntime.dispatchMessage({ command: 'containerLog', serviceId: 'service-1', log: 'first log' });
        expect(first.content.textContent).toBe('first log');

        const second = createLogDocument();
        const secondRuntime = runScript(second.document, firstRuntime.getState());

        expect(second.modal.hidden).toBe(false);
        expect(second.title.textContent).toBe('service-1');
        expect(second.content.textContent).toBe('正在加载日志...');
        expect(secondRuntime.messages).toContainEqual({ command: 'getContainerLog', serviceId: 'service-1' });

        secondRuntime.dispatchMessage({ command: 'containerLog', serviceId: 'service-1', log: 'latest log' });
        expect(second.content.textContent).toBe('latest log');
        second.document.dispatch('click', second.closeButton);
        expect(second.modal.hidden).toBe(true);
        expect(secondRuntime.getState()).toMatchObject({ log: { open: false, serviceId: 'service-1' } });
        secondRuntime.dispatchMessage({ command: 'containerLog', serviceId: 'service-1', log: 'stale log' });
        expect(second.modal.hidden).toBe(true);
    });
});
