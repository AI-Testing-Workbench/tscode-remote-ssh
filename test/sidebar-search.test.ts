import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { WEBVIEW_SCRIPT } from '../src/webviewScript';

describe('sidebar service search', () => {
    it('filters Host, Name, and service ID case-insensitively as the user types and resets on close', () => {
        const stateStore = createViewStateStore();
        const harness = createSearchHarness([
            { host: 'Host-Alpha', name: 'My Service', serviceId: 'service-one' },
            { host: 'HOST-Beta', name: 'Another Service', serviceId: 'SERVICE-TWO' },
        ], stateStore);
        harness.run();

        harness.openButton.fire('click');
        expect(harness.searchPanel.hidden).toBe(false);
        expect(harness.searchInput.focused).toBe(true);
        expect(harness.openButton.getAttribute('aria-expanded')).toBe('true');

        expectOnly(harness, 'host-beta', 1);
        expectOnly(harness, 'MY SERVICE', 0);
        expectOnly(harness, 'service-two', 1);
        expectOnly(harness, 'not-found', -1);
        expect(harness.noResultsState?.hidden).toBe(false);

        harness.searchInput.value = '   ';
        harness.searchInput.fire('input');
        expect(harness.cards.every(card => !card.hidden)).toBe(true);
        expect(harness.noResultsState?.hidden).toBe(true);

        harness.closeButton.fire('click');
        expect(harness.searchPanel.hidden).toBe(true);
        expect(harness.searchInput.value).toBe('');
        expect(harness.openButton.getAttribute('aria-expanded')).toBe('false');
        expect(harness.cards.every(card => !card.hidden)).toBe(true);
        expect(stateStore.get().serviceSearch).toEqual({ open: false, input: '', query: '' });
        expect(harness.api.postMessage).not.toHaveBeenCalled();
    });

    it('preserves the open search and live query across Webview rebuilds', () => {
        const stateStore = createViewStateStore();
        const first = createSearchHarness([
            { host: 'host-one', name: 'Primary', serviceId: 'service-one' },
        ], stateStore);
        first.run();
        first.openButton.fire('click');
        first.searchInput.value = 'PRIMARY';
        first.searchInput.fire('input');
        expect(first.cards[0].hidden).toBe(false);

        const rebuilt = createSearchHarness([
            { host: 'host-one', name: 'Primary', serviceId: 'service-one' },
            { host: 'host-two', name: 'Secondary', serviceId: 'service-two' },
        ], stateStore);
        rebuilt.run();

        expect(rebuilt.searchPanel.hidden).toBe(false);
        expect(rebuilt.searchInput.value).toBe('PRIMARY');
        expect(rebuilt.cards[0].hidden).toBe(false);
        expect(rebuilt.cards[1].hidden).toBe(true);

        rebuilt.closeButton.fire('click');
        expect(stateStore.get().serviceSearch).toEqual({ open: false, input: '', query: '' });
        expect(rebuilt.cards.every(card => !card.hidden)).toBe(true);
    });

    it('clears both page searches when switching between services and full-container files', () => {
        const stateStore = createViewStateStore();
        const services = createSearchHarness([
            { host: 'host-one', name: 'Primary', serviceId: 'service-one' },
        ], stateStore);
        services.run();
        services.openButton.fire('click');
        services.searchInput.value = 'stale-service-query';
        services.searchInput.fire('input');

        const files = createSearchHarness([
            { host: 'sandbox', name: 'sandbox', serviceId: 'file-service' },
        ], stateStore, 'files');
        files.run();
        expect(files.searchPanel.hidden).toBe(true);
        expect(files.searchInput.value).toBe('');
        expect(stateStore.get().serviceSearch).toEqual({ open: false, input: '', query: '' });
        expect(stateStore.get().containerFilesSearch).toEqual({ open: false, input: '', query: '' });

        files.openButton.fire('click');
        files.searchInput.value = 'gitee-query';
        files.searchInput.fire('input');
        expect(stateStore.get().containerFilesSearch).toEqual({ open: true, input: 'gitee-query', query: 'gitee-query' });

        const returnedServices = createSearchHarness([
            { host: 'host-one', name: 'Primary', serviceId: 'service-one' },
        ], stateStore);
        returnedServices.run();
        expect(returnedServices.searchPanel.hidden).toBe(true);
        expect(returnedServices.searchInput.value).toBe('');
        expect(stateStore.get().serviceSearch).toEqual({ open: false, input: '', query: '' });
        expect(stateStore.get().containerFilesSearch).toEqual({ open: false, input: '', query: '' });
    });

    it('updates only the existing empty-state message for a no-match query and restores it on close', () => {
        const harness = createSearchHarness([], createViewStateStore());
        harness.run();
        const originalEmptyState = harness.noServicesState;
        const originalEmptyText = harness.noServicesText;
        expect(harness.noServicesState?.hidden).toBe(false);
        expect(harness.noServicesText?.textContent).toBe('当前无可用沙箱，可通过上方按钮创建');
        expect(harness.noResultsState).toBeUndefined();

        harness.openButton.fire('click');
        harness.searchInput.value = 'missing-service';
        harness.searchInput.fire('input');

        expect(harness.noServicesState).toBe(originalEmptyState);
        expect(harness.noServicesText).toBe(originalEmptyText);
        expect(harness.noServicesState?.hidden).toBe(false);
        expect(harness.noServicesText?.textContent).toBe('没有找到符合搜索条件的云端沙箱');
        expect(harness.noResultsState).toBeUndefined();

        harness.closeButton.fire('click');
        expect(harness.noServicesState).toBe(originalEmptyState);
        expect(harness.noServicesState?.hidden).toBe(false);
        expect(harness.noServicesText?.textContent).toBe('当前无可用沙箱，可通过上方按钮创建');
    });

    it('searches C104 status, type, Gitee metadata, and expiration fields', () => {
        const harness = createSearchHarness([
            { host: 'sandbox', name: 'sandbox', serviceId: 'service-one', searchExtra: 'evaluation_cloud stopped alice repo-main 2026-12-01' },
            { host: 'another', name: 'another', serviceId: 'service-two', searchExtra: 'testagent_cloud running bob repo-two never' },
        ], createViewStateStore(), 'files');
        harness.run();

        expectOnly(harness, 'stopped', 0);
        expectOnly(harness, 'evaluation_cloud', 0);
        expectOnly(harness, 'alice', 0);
        expectOnly(harness, '2026-12-01', 0);
        expectOnly(harness, 'repo-two', 1);
    });
});

function expectOnly(harness: SearchHarness, query: string, visibleIndex: number): void {
    harness.searchInput.value = query;
    harness.searchInput.fire('input');
    harness.cards.forEach((card, index) => {
        expect(card.hidden).toBe(index !== visibleIndex);
    });
}

function createViewStateStore() {
    let state: Record<string, unknown> = {};
    const api = {
        getState: () => state,
        setState: (nextState: Record<string, unknown>) => {
            state = nextState;
        },
        postMessage: vi.fn(),
    };
    return {
        api,
        get: () => state,
    };
}

interface TestEvent {
    target: TestElement;
    key?: string;
    defaultPrevented: boolean;
    preventDefault(): void;
}

interface TestElement {
    value: string;
    hidden: boolean;
    focused: boolean;
    textContent: string;
    addEventListener(type: string, listener: (event: TestEvent) => void): void;
    fire(type: string, key?: string): TestEvent;
    focus(): void;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
}

interface SearchHarness {
    api: ReturnType<typeof createViewStateStore>['api'];
    cards: TestElement[];
    closeButton: TestElement;
    noResultsState?: TestElement;
    noServicesState?: TestElement;
    noServicesText?: TestElement;
    openButton: TestElement;
    searchInput: TestElement;
    searchPanel: TestElement;
    run(): void;
}

function createSearchHarness(
    services: Array<{ host: string; name: string; serviceId: string; searchExtra?: string }>,
    stateStore: ReturnType<typeof createViewStateStore>,
    pageMode: 'services' | 'files' = 'services',
): SearchHarness {
    const pageElement = createTestElement({ 'data-sidebar-page': pageMode });
    const searchPanel = createTestElement({ 'data-search-panel': '' });
    searchPanel.hidden = true;
    const searchInput = createTestElement({ 'data-search-input': '' });
    const openButton = createTestElement({ 'data-search-action': 'open' });
    const closeButton = createTestElement({ 'data-search-action': 'close' });
    const noServicesState = services.length === 0
        ? createTestElement({
            'data-empty-state': '',
            'data-search-message': '没有找到符合搜索条件的云端沙箱',
        })
        : undefined;
    const noServicesText = services.length === 0
        ? createTestElement({
            'data-empty-text': '',
            'data-empty-message': '当前无可用沙箱，可通过上方按钮创建',
        })
        : undefined;
    const noResultsState = services.length > 0
        ? createTestElement({ 'data-search-empty': '' })
        : undefined;
    if (noResultsState) {
        noResultsState.hidden = true;
    }
    const cards = services.map(service => createTestElement({
        'data-service-id': service.serviceId,
        'data-search-service-id': service.serviceId,
        'data-search-host': service.host,
        'data-search-name': service.name,
        'data-search-extra': service.searchExtra ?? '',
    }));
    const searchButtons = [openButton, closeButton];
    const document = {
        querySelector: (selector: string): TestElement | undefined => ({
            '[data-search-panel]': searchPanel,
            '[data-search-input]': searchInput,
            '[data-sidebar-page]': pageElement,
            '[data-empty-state]': noServicesState,
            '[data-empty-state] [data-empty-text]': noServicesText,
            '[data-search-empty]': noResultsState,
            '[data-search-action="open"]': openButton,
        }[selector]),
        querySelectorAll: (selector: string): TestElement[] => {
            if (selector === '[data-search-action]') {
                return searchButtons;
            }
            if (selector === '.container-card[data-service-id]') {
                return cards;
            }
            return [];
        },
    };

    return {
        api: stateStore.api,
        cards,
        closeButton,
        noResultsState,
        noServicesState,
        noServicesText,
        openButton,
        searchInput,
        searchPanel,
        run: () => new Script(WEBVIEW_SCRIPT).runInNewContext({
            acquireVsCodeApi: () => stateStore.api,
            document,
            window: { addEventListener: vi.fn() },
        }),
    };
}

function createTestElement(attributes: Record<string, string>): TestElement {
    const attributeMap = new Map(Object.entries(attributes));
    const listeners = new Map<string, (event: TestEvent) => void>();
    const element: TestElement = {
        value: '',
        hidden: false,
        focused: false,
        textContent: attributes['data-empty-message'] ?? '',
        addEventListener: (type, listener) => listeners.set(type, listener),
        fire: (type, key) => {
            const event: TestEvent = {
                target: element,
                key,
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
            };
            listeners.get(type)?.(event);
            return event;
        },
        focus: () => { element.focused = true; },
        getAttribute: name => attributeMap.get(name) ?? null,
        setAttribute: (name, value) => attributeMap.set(name, value),
    };
    return element;
}
