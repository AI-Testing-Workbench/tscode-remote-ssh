export const ADMIN_WEBVIEW_SCRIPT = String.raw`
/* global acquireVsCodeApi, document, window */
const vscode = acquireVsCodeApi();

const tabKind = tab => tab === 'images' ? 'images' : tab === 'containers' ? 'containers' : tab === 'whitelist' ? 'whitelist' : 'adminUsers';

const getSavedState = () => {
    const saved = vscode.getState();
    return saved && typeof saved === 'object' ? saved : {};
};

const getFieldStateKey = field => {
    const explicitKey = field.getAttribute('data-persist-key');
    if (explicitKey) return explicitKey;
    const fieldName = field.getAttribute('data-field');
    const form = field.closest('[data-form]');
    const formName = form ? form.getAttribute('data-form') : '';
    return formName && fieldName ? formName + '.' + fieldName : fieldName;
};

const getFocusStateKey = element => {
    if (!element || !element.matches) return '';
    if (element.matches('[data-field]')) {
        const fieldKey = getFieldStateKey(element);
        const radioValue = element.type === 'radio' ? ':' + (element.value || '') : '';
        return fieldKey ? 'field.' + fieldKey + radioValue : '';
    }
    if (element.matches('[data-search-input]')) {
        const panel = element.closest('[data-tab-panel]');
        const controls = panel?.querySelector('[data-list-controls]');
        const kind = controls?.getAttribute('data-list-kind');
        return kind ? 'search.' + kind : 'search';
    }
    if (element.matches('[data-select-trigger]')) {
        const wrapper = element.closest('[data-custom-select]');
        const select = wrapper?.querySelector('select');
        const controls = select?.closest('[data-list-controls]');
        const kind = controls?.getAttribute('data-list-kind');
        let key = select?.getAttribute('data-persist-key');
        if (!key && kind && select?.matches('[data-sort-select]')) key = 'list.' + kind + '.sort';
        if (!key && kind && select?.matches('[data-status-filter]')) key = 'list.' + kind + '.status';
        if (!key && kind && select?.matches('[data-page-size]')) key = 'list.' + kind + '.pageSize';
        return key ? 'select.' + key : '';
    }
    if (element.matches('[data-page-action], [data-sort-toggle]')) {
        const controls = element.closest('[data-list-controls]');
        const kind = controls?.getAttribute('data-list-kind');
        const action = element.getAttribute('data-page-action') || 'sort';
        return kind ? 'control.' + kind + '.' + action : '';
    }
    if (element.matches('[data-action]')) {
        const action = element.getAttribute('data-action') || '';
        const identity = [
            element.getAttribute('data-container-id'),
            element.getAttribute('data-container-action'),
            element.getAttribute('data-full-name'),
            element.getAttribute('data-user-id'),
            element.getAttribute('data-type'),
            element.getAttribute('data-tab'),
        ].join(':');
        return 'action.' + action + ':' + identity;
    }
    return '';
};

const getActiveFocusState = () => {
    const active = document.activeElement;
    const key = getFocusStateKey(active);
    if (!key) return undefined;
    const focus = { key };
    if (typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
        focus.start = active.selectionStart;
        focus.end = active.selectionEnd;
        if (typeof active.selectionDirection === 'string') focus.direction = active.selectionDirection;
    }
    return focus;
};

const clearFocusState = () => {
    const saved = getSavedState();
    if (!Object.prototype.hasOwnProperty.call(saved, 'focus')) return;
    const next = { ...saved };
    delete next.focus;
    vscode.setState(next);
};

const saveFocusState = () => {
    const focus = getActiveFocusState();
    const saved = getSavedState();
    if (!focus) {
        clearFocusState();
        return;
    }
    vscode.setState({ ...saved, focus });
};

const findFocusableElement = key => Array.from(document.querySelectorAll('[data-field], [data-search-input], [data-select-trigger], [data-page-action], [data-sort-toggle], [data-action]'))
    .find(element => getFocusStateKey(element) === key);

const restoreFocusState = () => {
    const saved = getSavedState();
    if (saved.log && saved.log.open === true || !saved.focus || typeof saved.focus.key !== 'string') return;
    restoreFocusSnapshot(saved.focus);
};

const restoreFocusSnapshot = focus => {
    if (!focus || typeof focus.key !== 'string') return;
    const element = findFocusableElement(focus.key);
    if (!element || typeof element.focus !== 'function') return;
    element.focus();
    if (typeof element.setSelectionRange !== 'function' || typeof focus.start !== 'number' || typeof focus.end !== 'number') return;
    const valueLength = typeof element.value === 'string' ? element.value.length : focus.end;
    const start = Math.min(Math.max(0, focus.start), valueLength);
    const end = Math.min(Math.max(start, focus.end), valueLength);
    try {
        element.setSelectionRange(start, end, focus.direction || 'none');
    } catch {
        // Some input types do not support selection even when the browser exposes the method.
    }
};

const getSavedCollapsibleState = () => {
    const saved = getSavedState();
    return saved.collapsible && typeof saved.collapsible === 'object' ? saved.collapsible : {};
};

const saveCollapsibleState = () => {
    const cards = {};
    document.querySelectorAll('details[data-form]').forEach(card => {
        const key = card.getAttribute('data-form');
        if (key) cards[key] = Boolean(card.open);
    });
    if (!Object.keys(cards).length) return;
    const saved = getSavedState();
    vscode.setState({ ...saved, collapsible: { ...getSavedCollapsibleState(), ...cards } });
};

const restoreCollapsibleState = () => {
    const saved = getSavedCollapsibleState();
    document.querySelectorAll('details[data-form]').forEach(card => {
        const key = card.getAttribute('data-form');
        if (!key || !Object.prototype.hasOwnProperty.call(saved, key) || typeof saved[key] !== 'boolean') return;
        card.open = saved[key];
    });
};

const saveFormState = () => {
    const saved = getSavedState();
    const previousFields = saved.fields && typeof saved.fields === 'object' ? saved.fields : {};
    const fields = { ...previousFields };
    document.querySelectorAll('[data-field]').forEach(field => {
        const key = getFieldStateKey(field);
        if (!key) return;
        if (field.type === 'radio') {
            if (field.checked) fields[key] = field.value;
            return;
        }
        fields[key] = field.type === 'checkbox' ? Boolean(field.checked) : field.value;
    });
    const focus = getActiveFocusState();
    const next = { ...saved, fields };
    if (focus) {
        next.focus = focus;
    } else {
        delete next.focus;
    }
    vscode.setState(next);
};

const ensureSelectValue = (field, value) => {
    if (!field.matches || !field.matches('select') || !field.options || typeof value !== 'string' || !value || typeof field.appendChild !== 'function') return;
    if (Array.from(field.options).some(option => option.value === value)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = true;
    field.appendChild(option);
};

const restoreFormState = () => {
    const saved = getSavedState();
    const fields = saved.fields;
    if (!fields || typeof fields !== 'object') return;
    document.querySelectorAll('[data-field]').forEach(field => {
        const key = getFieldStateKey(field);
        if (!key || !Object.prototype.hasOwnProperty.call(fields, key)) return;
        const value = fields[key];
        if (field.type === 'radio') {
            field.checked = value === field.value;
        } else if (field.type === 'checkbox') {
            field.checked = value === true;
        } else if (typeof value === 'string' || typeof value === 'number') {
            const stringValue = String(value);
            ensureSelectValue(field, stringValue);
            field.value = stringValue;
        }
    });
};

const getSavedLogState = () => {
    const saved = getSavedState();
    return saved.log && typeof saved.log === 'object' ? saved.log : {};
};

const saveLogState = patch => {
    const saved = getSavedState();
    vscode.setState({ ...saved, log: { ...getSavedLogState(), ...patch } });
};

const updateLogModal = (containerId, content) => {
    const modal = document.querySelector('[data-log-modal]');
    const title = document.querySelector('[data-log-title]');
    const logContent = document.querySelector('[data-log-content]');
    const refresh = document.querySelector('[data-log-refresh]');
    if (title) title.textContent = containerId || '未选择容器';
    if (logContent) logContent.textContent = content;
    if (refresh) refresh.setAttribute('data-container-id', containerId);
    if (modal) modal.hidden = false;
};

const openContainerLog = containerId => {
    if (!containerId) return;
    updateLogModal(containerId, '正在加载日志...');
    saveLogState({ open: true, containerId });
    post('setLogOpen', { open: true });
};

const restoreLogState = () => {
    const saved = getSavedLogState();
    if (saved.open !== true || typeof saved.containerId !== 'string' || !saved.containerId) return;
    openContainerLog(saved.containerId);
    post('getContainerLog', { containerId: saved.containerId });
};

const getListContext = () => {
    const panel = document.querySelector('[data-tab-panel]');
    if (!panel) return {};
    return {
        panel,
        list: panel.querySelector('[data-resource-list]'),
        items: panel.querySelector('[data-resource-items]'),
        controls: panel.querySelector('[data-list-controls]'),
        searchInput: panel.querySelector('[data-search-input]'),
    };
};

const getSavedListState = kind => {
    const saved = getSavedState();
    if (saved.lists && saved.lists[kind]) return saved.lists[kind];
    if (saved.listKind === kind) return saved;
    return {};
};

const saveListState = () => {
    const { controls, searchInput } = getListContext();
    if (!controls) return;
    const kind = controls.getAttribute('data-list-kind');
    const sortSelect = controls.querySelector('[data-sort-select]');
    const statusSelect = controls.querySelector('[data-status-filter]');
    const typeFilterSelect = controls.querySelector('[data-type-filter]');
    const pageSizeSelect = controls.querySelector('[data-page-size]');
    const saved = getSavedState();
    const lists = { ...(saved.lists || {}) };
    lists[kind] = {
        search: searchInput ? searchInput.value : '',
        sortKey: sortSelect ? sortSelect.value : '',
        sortDirection: controls.getAttribute('data-sort-direction') || 'asc',
        statusFilter: statusSelect ? statusSelect.value : 'all',
        typeFilter: typeFilterSelect ? typeFilterSelect.value : 'all',
        pageSize: pageSizeSelect ? pageSizeSelect.value : '20',
        page: controls.getAttribute('data-page') || '1',
    };
    vscode.setState({
        ...saved,
        lists,
        listKind: controls.getAttribute('data-list-kind'),
    });
};

const restoreListState = () => {
    const { controls, searchInput } = getListContext();
    if (!controls) return;
    const kind = controls.getAttribute('data-list-kind');
    const saved = getSavedListState(kind);
    const sortSelect = controls.querySelector('[data-sort-select]');
    const statusSelect = controls.querySelector('[data-status-filter]');
    const typeFilterSelect = controls.querySelector('[data-type-filter]');
    const pageSizeSelect = controls.querySelector('[data-page-size]');
    if (searchInput && typeof saved.search === 'string') searchInput.value = saved.search;
    if (sortSelect && typeof saved.sortKey === 'string' && Array.from(sortSelect.options).some(option => option.value === saved.sortKey)) sortSelect.value = saved.sortKey;
    if (statusSelect && typeof saved.statusFilter === 'string' && Array.from(statusSelect.options).some(option => option.value === saved.statusFilter)) statusSelect.value = saved.statusFilter;
    if (typeFilterSelect && typeof saved.typeFilter === 'string' && Array.from(typeFilterSelect.options).some(option => option.value === saved.typeFilter)) typeFilterSelect.value = saved.typeFilter;
    if (pageSizeSelect && typeof saved.pageSize === 'string' && Array.from(pageSizeSelect.options).some(option => option.value === saved.pageSize)) pageSizeSelect.value = saved.pageSize;
    if (saved.sortDirection === 'desc') controls.setAttribute('data-sort-direction', 'desc');
    if (typeof saved.page === 'string') controls.setAttribute('data-page', saved.page);
    updateSortToggle(controls, saved.sortDirection === 'desc' ? 'desc' : 'asc');
};

const post = (command, payload = {}) => {
    if (!command) return;
    saveFormState();
    saveCollapsibleState();
    if (typeof vscode.postMessage === 'function') vscode.postMessage({ command, ...payload });
};

const getNodeKey = node => {
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') return '';
    const patchKey = node.getAttribute('data-patch-key');
    if (patchKey) return 'patch:' + patchKey;
    const formKey = node.getAttribute('data-form');
    if (formKey) return 'form:' + formKey;
    const persistKey = node.getAttribute('data-persist-key');
    if (persistKey) {
        const type = (node.getAttribute('type') || '').toLowerCase();
        return 'persist:' + persistKey + (type === 'radio' ? ':' + (node.getAttribute('value') || '') : '');
    }
    const action = node.getAttribute('data-action');
    if (action) {
        return 'action:' + action + ':' + [
            node.getAttribute('data-container-id'),
            node.getAttribute('data-container-action'),
            node.getAttribute('data-full-name'),
            node.getAttribute('data-user-id'),
            node.getAttribute('data-type'),
            node.getAttribute('data-tab'),
        ].join(':');
    }
    if (node.id) return 'id:' + node.id;
    return '';
};

const nodeName = node => String(node?.nodeName || node?.tagName || '').toLowerCase();

const isCompatibleNode = (current, next) => current && next
    && current.nodeType === next.nodeType
    && (current.nodeType !== 1 || nodeName(current) === nodeName(next));

const isFormControl = node => {
    const tag = nodeName(node);
    return tag === 'input' || tag === 'select' || tag === 'textarea';
};

const captureNodeState = node => {
    const state = {};
    if (isFormControl(node) && 'value' in node) state.value = node.value;
    if (nodeName(node) === 'input' && 'checked' in node) state.checked = node.checked;
    if (nodeName(node) === 'details' && 'open' in node) state.open = node.open;
    if (typeof node.scrollTop === 'number') state.scrollTop = node.scrollTop;
    if (typeof node.scrollLeft === 'number') state.scrollLeft = node.scrollLeft;
    return state;
};

const restoreNodeState = (node, state) => {
    if (!state) return;
    if (Object.prototype.hasOwnProperty.call(state, 'value') && isFormControl(node)) node.value = state.value;
    if (Object.prototype.hasOwnProperty.call(state, 'checked') && nodeName(node) === 'input') node.checked = state.checked;
    if (Object.prototype.hasOwnProperty.call(state, 'open') && nodeName(node) === 'details') node.open = state.open;
    if (typeof state.scrollTop === 'number') node.scrollTop = state.scrollTop;
    if (typeof state.scrollLeft === 'number') node.scrollLeft = state.scrollLeft;
};

const shouldPreserveAttribute = (current, name, keepLoading) => {
    const tag = nodeName(current);
    if (name === 'value' && isFormControl(current)) return true;
    if (name === 'checked' && tag === 'input') return true;
    if (name === 'selected' && tag === 'option') return true;
    if (name === 'open' && tag === 'details') return true;
    if (keepLoading && (name === 'disabled' || name === 'aria-busy')) return true;
    if (keepLoading && name === 'data-refresh-disabled') return true;
    if (name === 'hidden' && current.matches?.('[data-log-modal]') && getSavedLogState().open === true) return true;
    return false;
};

const patchAttributes = (current, next) => {
    const keepLoading = current.classList?.contains('is-loading');
    const nextAttributes = Array.from(next.attributes || []);
    const nextNames = new Set(nextAttributes.map(attribute => attribute.name));
    if (keepLoading && current.matches?.('[data-action]')) {
        current.setAttribute('data-refresh-disabled', next.hasAttribute('disabled') ? 'true' : 'false');
    }
    Array.from(current.attributes || []).forEach(attribute => {
        if (!nextNames.has(attribute.name) && !shouldPreserveAttribute(current, attribute.name, keepLoading)) {
            current.removeAttribute(attribute.name);
        }
    });
    nextAttributes.forEach(attribute => {
        if (shouldPreserveAttribute(current, attribute.name, keepLoading)) return;
        let value = attribute.value;
        if (attribute.name === 'class' && keepLoading && !value.split(/\s+/).includes('is-loading')) {
            value += ' is-loading';
        }
        if (current.getAttribute(attribute.name) !== value) current.setAttribute(attribute.name, value);
    });
};

const insertNode = (parent, node, before) => {
    if (typeof parent.insertBefore === 'function') {
        parent.insertBefore(node, before || null);
    } else {
        parent.appendChild(node);
    }
};

const morphChildren = (current, next) => {
    const oldChildren = Array.from(current.childNodes || []);
    const used = new Set();
    const nextChildren = Array.from(next.childNodes || []);
    nextChildren.forEach((nextChild, index) => {
        const key = getNodeKey(nextChild);
        const candidate = oldChildren.find(child => {
            if (used.has(child) || !isCompatibleNode(child, nextChild)) return false;
            if (key) return getNodeKey(child) === key;
            return !getNodeKey(child);
        });
        if (!candidate) {
            const created = nextChild.cloneNode(true);
            insertNode(current, created, current.childNodes[index]);
            used.add(created);
            return;
        }
        used.add(candidate);
        const before = current.childNodes[index];
        if (before !== candidate) insertNode(current, candidate, before);
        morphNode(candidate, nextChild);
    });
    oldChildren.forEach(child => {
        if (!used.has(child) && child.parentNode === current) current.removeChild(child);
    });
};

const morphNode = (current, next) => {
    if (!isCompatibleNode(current, next)) {
        const replacement = next.cloneNode(true);
        current.parentNode?.replaceChild(replacement, current);
        return replacement;
    }
    if (current.matches?.('[data-log-modal]') && getSavedLogState().open === true
        || current.matches?.('[data-custom-select].open')) {
        return current;
    }
    if (current.nodeType !== 1) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
        return current;
    }
    const state = captureNodeState(current);
    patchAttributes(current, next);
    morphChildren(current, next);
    restoreNodeState(current, state);
    return current;
};

const capturePageState = () => {
    const scrollingElement = document.scrollingElement;
    const hasFocus = typeof document.hasFocus !== 'function' || document.hasFocus();
    return {
        focus: hasFocus ? getActiveFocusState() : undefined,
        scrollLeft: scrollingElement && typeof scrollingElement.scrollLeft === 'number' ? scrollingElement.scrollLeft : window.scrollX,
        scrollTop: scrollingElement && typeof scrollingElement.scrollTop === 'number' ? scrollingElement.scrollTop : window.scrollY,
    };
};

const restorePageState = state => {
    if (state?.focus) restoreFocusSnapshot(state.focus);
    if (typeof state?.scrollLeft !== 'number' || typeof state?.scrollTop !== 'number') return;
    if (typeof window.scrollTo === 'function') window.scrollTo(state.scrollLeft, state.scrollTop);
};

const parseAdminContent = html => {
    if (typeof html !== 'string' || !html.trim()) return undefined;
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content?.firstElementChild;
};

const applyAdminUpdate = html => {
    const nextRoot = parseAdminContent(html);
    const currentRoot = document.body?.firstElementChild;
    if (!nextRoot || !currentRoot) return;
    const pageState = capturePageState();
    morphNode(currentRoot, nextRoot);
    restoreFormState();
    restoreCollapsibleState();
    updateGiteeMode();
    restoreListState();
    syncCustomSelects();
    applyListView();
    restorePageState(pageState);
};

const readForm = root => {
    const values = {};
    if (!root) return values;
    root.querySelectorAll('[data-field]').forEach(field => {
        const name = field.getAttribute('data-field');
        if (!name) return;
        if (field.disabled) return;
        if (field.type === 'radio' && !field.checked) return;
        values[name] = field.type === 'checkbox' ? field.checked : field.value;
    });
    return values;
};

const readButtonData = button => {
    const values = {};
    if (button.dataset.containerId) values.containerId = button.dataset.containerId;
    if (button.dataset.containerAction) values.action = button.dataset.containerAction;
    if (button.dataset.fullName) values.fullName = button.dataset.fullName;
    if (button.dataset.userId) values.userId = button.dataset.userId;
    if (button.dataset.type) values.type = button.dataset.type;
    if (button.dataset.tab) values.tab = button.dataset.tab;
    if (button.dataset.orphanContainerIds) values.orphanContainerIds = button.dataset.orphanContainerIds;
    return values;
};

const startLoading = button => {
    if (button.disabled || button.classList.contains('is-loading')) return false;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    return true;
};

const compareRows = (left, right, sortKey, direction) => {
    const leftValue = left.getAttribute('data-sort-' + sortKey) || '';
    const rightValue = right.getAttribute('data-sort-' + sortKey) || '';
    let result;
    if (sortKey === 'size') {
        result = Number(leftValue) - Number(rightValue);
    } else {
        result = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' });
    }
    return direction === 'desc' ? -result : result;
};

const normalizeSearch = value => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

const getSearchTokens = value => normalizeSearch(value).split(' ').filter(Boolean);

const matchesSearch = (row, tokens) => {
    if (!tokens.length) return true;
    const searchText = normalizeSearch(row.getAttribute('data-search-text') || '');
    return tokens.every(token => searchText.includes(token));
};

const updateSortToggle = (controls, direction) => {
    if (!controls) return;
    const sortToggle = controls.querySelector('[data-sort-toggle]');
    if (!sortToggle) return;
    const arrow = sortToggle.querySelector('[data-sort-arrow]');
    const label = sortToggle.querySelector('[data-sort-label]');
    if (arrow) arrow.textContent = direction === 'desc' ? '↓' : '↑';
    if (label) label.textContent = direction === 'desc' ? '降序' : '升序';
};

const syncCustomSelect = select => {
    const wrapper = select?.closest ? select.closest('[data-custom-select]') : null;
    if (!wrapper) return;
    const selectedOption = Array.from(select.options).find(option => option.value === select.value) || select.options[0];
    const menu = wrapper.querySelector('[data-select-menu]');
    if (menu && select.value && !Array.from(menu.querySelectorAll('[data-select-option]')).some(option => option.getAttribute('data-select-value') === select.value)) {
        const option = document.createElement('button');
        option.setAttribute('class', 'select-option');
        option.setAttribute('type', 'button');
        option.setAttribute('role', 'option');
        option.setAttribute('data-select-option', '');
        option.setAttribute('data-select-value', select.value);
        option.setAttribute('aria-selected', 'true');
        option.textContent = selectedOption?.textContent || select.value;
        menu.appendChild(option);
    }
    const label = wrapper.querySelector('[data-select-label]');
    if (label && selectedOption) label.textContent = selectedOption.textContent || select.value;
    wrapper.querySelectorAll('[data-select-option]').forEach(option => {
        const selected = option.getAttribute('data-select-value') === select.value;
        if (selected) option.classList.add('selected');
        else option.classList.remove('selected');
        option.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
};

const syncCustomSelects = () => {
    document.querySelectorAll('[data-custom-select] select').forEach(syncCustomSelect);
};

const closeCustomSelects = except => {
    let closed = false;
    document.querySelectorAll('[data-custom-select].open').forEach(wrapper => {
        if (wrapper === except) return;
        wrapper.classList.remove('open');
        wrapper.querySelector('[data-select-trigger]')?.setAttribute('aria-expanded', 'false');
        closed = true;
    });
    if (closed) post('setSelectOpen', { open: false });
};

const applyListView = () => {
    const { list, items, controls, searchInput } = getListContext();
    if (!list || !items || !controls) return;

    const rows = Array.from(items.querySelectorAll('.searchable'));
    controls.hidden = rows.length === 0;
    const searchTokens = getSearchTokens(searchInput ? searchInput.value : '');
    const sortSelect = controls.querySelector('[data-sort-select]');
    const sortKey = sortSelect ? sortSelect.value : controls.getAttribute('data-default-sort');
    const direction = controls.getAttribute('data-sort-direction') || 'asc';
    const statusSelect = controls.querySelector('[data-status-filter]');
    const statusFilter = statusSelect ? statusSelect.value : 'all';
    const typeFilterSelect = controls.querySelector('[data-type-filter]');
    const typeFilter = typeFilterSelect ? typeFilterSelect.value : 'all';
    const pageSizeSelect = controls.querySelector('[data-page-size]');
    const requestedPageSize = pageSizeSelect ? Number(pageSizeSelect.value) : 20;
    const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 20;
    const requestedPage = Number(controls.getAttribute('data-page') || '1');
    let page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const sortedRows = [...rows];
    if (sortKey) sortedRows.sort((left, right) => compareRows(left, right, sortKey, direction));
    const matchingRows = sortedRows.filter(item => {
        const matchesSearchResult = matchesSearch(item, searchTokens);
        const matchesStatus = statusFilter === 'all' || item.getAttribute('data-filter-status') === statusFilter;
        const matchesType = typeFilter === 'all' || item.getAttribute('data-filter-type') === typeFilter;
        return matchesSearchResult && matchesStatus && matchesType;
    });
    const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize));
    page = Math.min(Math.max(1, page), pageCount);
    controls.setAttribute('data-page', String(page));
    const visibleRows = new Set(matchingRows.slice((page - 1) * pageSize, page * pageSize));
    sortedRows.forEach((row, index) => {
        if (items.children?.[index] !== row) insertNode(items, row, items.children?.[index]);
        row.hidden = !visibleRows.has(row);
    });
    items.hidden = rows.length > 0 && matchingRows.length === 0;
    const emptyData = list.querySelector('[data-empty-data]');
    if (emptyData) emptyData.hidden = rows.length !== 0;
    const emptySearch = list.querySelector('[data-empty-search]');
    if (emptySearch) emptySearch.hidden = rows.length === 0 || matchingRows.length !== 0;
    const indicator = controls.querySelector('[data-page-indicator]');
    if (indicator) indicator.textContent = '第 ' + page + '/' + pageCount + ' 页 · 共' + matchingRows.length + ' 个条目';
    const previous = controls.querySelector('[data-page-action="previous"]');
    const next = controls.querySelector('[data-page-action="next"]');
    if (previous) previous.disabled = page <= 1;
    if (next) next.disabled = page >= pageCount;
};

const updateGiteeMode = () => {
    const selected = document.querySelector('[data-field="giteeMode"]:checked')?.value || 'none';
    document.querySelectorAll('[data-gitee-mode-panel]').forEach(panel => {
        const active = panel.getAttribute('data-gitee-mode-panel') === selected;
        if (active) {
            panel.classList.remove('inactive');
        } else {
            panel.classList.add('inactive');
        }
        panel.querySelectorAll('[data-field]').forEach(field => { field.disabled = !active; });
    });
};

document.addEventListener('click', event => {
    const target = event.target;
    const option = target && target.closest ? target.closest('[data-select-option]') : null;
    if (option) {
        if (option.disabled) return;
        const wrapper = option.closest('[data-custom-select]');
        const select = wrapper?.querySelector('select');
        if (select) {
            select.value = option.getAttribute('data-select-value') || '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeCustomSelects();
        return;
    }
    const trigger = target && target.closest ? target.closest('[data-select-trigger]') : null;
    if (trigger) {
        const wrapper = trigger.closest('[data-custom-select]');
        const open = !wrapper?.classList.contains('open');
        closeCustomSelects(open ? wrapper : null);
        if (wrapper && open) {
            wrapper.classList.add('open');
            trigger.setAttribute('aria-expanded', 'true');
            post('setSelectOpen', { open: true });
        }
        return;
    }
    closeCustomSelects();
    const pageButton = target && target.closest ? target.closest('[data-page-action]') : null;
    if (pageButton) {
        const controls = pageButton.closest('[data-list-controls]');
        const page = Number(controls?.getAttribute('data-page') || '1');
        controls?.setAttribute('data-page', String(pageButton.getAttribute('data-page-action') === 'next' ? page + 1 : page - 1));
        saveListState();
        applyListView();
        return;
    }
    const sortToggle = target && target.closest ? target.closest('[data-sort-toggle]') : null;
    if (sortToggle) {
        const controls = sortToggle.closest('[data-list-controls]');
        const nextDirection = controls?.getAttribute('data-sort-direction') === 'desc' ? 'asc' : 'desc';
        controls?.setAttribute('data-sort-direction', nextDirection);
        updateSortToggle(controls, nextDirection);
        saveListState();
        applyListView();
        return;
    }
    const button = target && target.closest ? target.closest('[data-action]') : null;
    if (!button) return;

    const action = button.getAttribute('data-action');
    if (!action) return;
    if (action === 'closeContainerLog') {
        const modal = document.querySelector('[data-log-modal]');
        if (modal) modal.hidden = true;
        saveLogState({ open: false });
        post('setLogOpen', { open: false });
        return;
    }
    if (action === 'tab') {
        saveListState();
        const saved = getSavedState();
        vscode.setState({ ...saved, listKind: tabKind(button.getAttribute('data-tab')) });
        post('selectTab', { tab: button.getAttribute('data-tab') });
        return;
    }

    if (!startLoading(button)) return;
    if (action === 'getContainerLog') {
        openContainerLog(button.getAttribute('data-container-id') || '');
    }
    const form = button.closest('[data-form]') || button.closest('.resource-row');
    post(action, { ...readForm(form), ...readButtonData(button) });
});

document.addEventListener('input', event => {
    const target = event.target;
    if (target && target.matches && target.matches('[data-field]')) saveFormState();
    const input = target && target.matches && target.matches('[data-search-input]') ? target : null;
    if (input) {
        const { controls } = getListContext();
        controls?.setAttribute('data-page', '1');
        applyListView();
        saveListState();
        saveFocusState();
    }
});

document.addEventListener('change', event => {
    const select = event.target;
    if (select && select.matches && select.matches('[data-field]')) saveFormState();
    if (select && select.matches && select.matches('.native-select')) syncCustomSelect(select);
    if (select && select.matches && select.matches('[data-sort-select], [data-status-filter], [data-type-filter], [data-page-size]')) {
        const controls = select.closest('[data-list-controls]');
        controls?.setAttribute('data-page', '1');
        saveListState();
        applyListView();
        return;
    }
    if (select && select.matches && select.matches('[data-field="giteeMode"]')) updateGiteeMode();
});

document.addEventListener('focusin', saveFocusState);
document.addEventListener('focusout', clearFocusState);
document.addEventListener('select', saveFocusState);
document.addEventListener('keyup', saveFocusState);
document.addEventListener('mouseup', saveFocusState);
window.addEventListener('blur', () => {
    closeCustomSelects();
    clearFocusState();
});
document.addEventListener('toggle', event => {
    const target = event.target;
    if (target && target.matches && target.matches('details[data-form]')) saveCollapsibleState();
}, true);

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.command !== 'adminUpdate') return;
    applyAdminUpdate(message.html);
});

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.command !== 'operationComplete') return;

    document.querySelectorAll('[data-action]').forEach(button => {
        if (!button.classList.contains('is-loading')) return;
        if (typeof message.action === 'string' && button.getAttribute('data-action') !== message.action) return;
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        const refreshedDisabled = button.getAttribute('data-refresh-disabled');
        button.removeAttribute('data-refresh-disabled');
        if (refreshedDisabled === 'true') {
            button.disabled = true;
            button.setAttribute('disabled', '');
        } else {
            button.disabled = false;
            button.removeAttribute('disabled');
        }
    });
});

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.command !== 'imageFileSelected') return;
    const filename = typeof message.filename === 'string' && message.filename ? message.filename : '未选择镜像文件';
    const selectedFile = document.querySelector('[data-selected-file]');
    if (selectedFile) selectedFile.textContent = filename;
});

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.command !== 'containerLog') return;
    const containerId = typeof message.containerId === 'string' ? message.containerId : '';
    const savedLog = getSavedLogState();
    if (savedLog.open !== true || savedLog.containerId !== containerId) return;
    const logText = typeof message.log === 'string' && message.log ? message.log : '暂无日志';
    updateLogModal(containerId, logText);
    saveLogState({ open: true, containerId });
});

restoreFormState();
restoreCollapsibleState();
updateGiteeMode();
restoreListState();
syncCustomSelects();
applyListView();
restoreLogState();
restoreFocusState();
post('ready');
`;
