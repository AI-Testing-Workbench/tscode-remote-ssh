import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADMIN_WEBVIEW_SCRIPT } from '../src/adminWebview/script';

interface FakeOption {
    value: string;
}

type EventListener = (event: { target: FakeElement }) => void;

class FakeClassList {
    private readonly values = new Set<string>();

    public constructor(classes = '') {
        classes.split(/\s+/).filter(Boolean).forEach(value => this.values.add(value));
    }

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
    public readonly classList: FakeClassList;
    public readonly options: FakeOption[] = [];
    public parent: FakeElement | undefined;
    public hidden = false;
    public disabled = false;
    public checked = false;
    public value = '';
    public type = '';
    public textContent = '';

    public constructor(
        private readonly tagName: string,
        private readonly attributes: Record<string, string> = {},
    ) {
        this.classList = new FakeClassList(attributes.class);
        this.value = attributes.value ?? '';
        this.type = attributes.type ?? '';
        this.checked = 'checked' in attributes;
    }

    public appendChild(child: FakeElement): FakeElement {
        if (child.parent) {
            const index = child.parent.children.indexOf(child);
            if (index >= 0) {
                child.parent.children.splice(index, 1);
            }
        }
        child.parent = this;
        this.children.push(child);
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
        return selector.split(',').some(part => this.matchesSimpleSelector(part.trim()));
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
        // The browser focuses the input; no-op for this DOM test double.
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
}

class FakeDocument extends FakeElement {
    private readonly listeners = new Map<string, EventListener[]>();

    public constructor() {
        super('#document');
    }

    public addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    public dispatch(type: string, target: FakeElement): void {
        this.listeners.get(type)?.forEach(listener => listener({ target }));
    }
}

function createSearchDocument(): { document: FakeDocument; searchInput: FakeElement; rows: FakeElement[]; items: FakeElement; emptySearch: FakeElement; indicator: FakeElement } {
    const document = new FakeDocument();
    const panel = new FakeElement('section', { 'data-tab-panel': '' });
    const searchInput = new FakeElement('input', { 'data-search-input': '', type: 'search' });
    const controls = new FakeElement('div', { 'data-list-controls': '', 'data-list-kind': 'images', 'data-default-sort': 'name' });
    const sortSelect = new FakeElement('select', { 'data-sort-select': '', value: 'name' });
    sortSelect.options.push({ value: 'name' }, { value: 'status' });
    const statusSelect = new FakeElement('select', { 'data-status-filter': '', value: 'all' });
    statusSelect.options.push({ value: 'all' }, { value: 'pushed' }, { value: 'not_pushed' });
    const pageSize = new FakeElement('select', { 'data-page-size': '', value: '1' });
    pageSize.options.push({ value: '1' }, { value: '20' });
    const sortToggle = new FakeElement('button', { 'data-sort-toggle': '' });
    sortToggle.appendChild(new FakeElement('span', { 'data-sort-arrow': '' }));
    sortToggle.appendChild(new FakeElement('span', { 'data-sort-label': '' }));
    const previous = new FakeElement('button', { 'data-page-action': 'previous' });
    const next = new FakeElement('button', { 'data-page-action': 'next' });
    const indicator = new FakeElement('span', { 'data-page-indicator': '' });
    const items = new FakeElement('div', { 'data-resource-items': '' });
    const list = new FakeElement('div', { 'data-resource-list': '' });
    const emptySearch = new FakeElement('p', { 'data-empty-search': '' });

    controls.appendChild(sortSelect);
    controls.appendChild(statusSelect);
    controls.appendChild(pageSize);
    controls.appendChild(sortToggle);
    controls.appendChild(previous);
    controls.appendChild(next);
    controls.appendChild(indicator);
    list.appendChild(items);
    list.appendChild(emptySearch);
    panel.appendChild(searchInput);
    panel.appendChild(controls);
    panel.appendChild(list);
    document.appendChild(panel);

    const rows = [
        new FakeElement('article', {
            class: 'searchable',
            'data-search-text': 'alpha registry pushed',
            'data-filter-status': 'pushed',
            'data-sort-name': 'alpha',
            'data-sort-status': 'pushed',
        }),
        new FakeElement('article', {
            class: 'searchable',
            'data-search-text': 'beta registry not_pushed',
            'data-filter-status': 'not_pushed',
            'data-sort-name': 'beta',
            'data-sort-status': 'not_pushed',
        }),
    ];
    rows.forEach(row => items.appendChild(row));
    return { document, searchInput, rows, items, emptySearch, indicator };
}

function runSearchScript(document: FakeDocument): void {
    let state: Record<string, unknown> = {};
    const window = { addEventListener: (): void => undefined };
    new Script(ADMIN_WEBVIEW_SCRIPT).runInNewContext({
        acquireVsCodeApi: () => ({
            getState: () => state,
            setState: (next: Record<string, unknown>) => { state = next; },
        }),
        document,
        window,
    });
}

describe('Admin Webview search', () => {
    it('filters the current list, resets pagination, and exposes the empty result state', () => {
        const { document, searchInput, rows, items, emptySearch, indicator } = createSearchDocument();
        runSearchScript(document);

        const controls = document.querySelector('[data-list-controls]');
        controls?.setAttribute('data-page', '4');
        searchInput.value = ' BETA ';
        document.dispatch('input', searchInput);

        expect(rows[0].hidden).toBe(true);
        expect(rows[1].hidden).toBe(false);
        expect(controls?.getAttribute('data-page')).toBe('1');
        expect(emptySearch.hidden).toBe(true);
        expect(indicator.textContent).toBe('第 1/1 页 · 1 项');

        searchInput.value = 'does-not-exist';
        document.dispatch('input', searchInput);

        expect(rows.every(row => row.hidden)).toBe(true);
        expect(items.hidden).toBe(true);
        expect(emptySearch.hidden).toBe(false);
        expect(indicator.textContent).toBe('第 1/1 页 · 0 项');
    });
});
