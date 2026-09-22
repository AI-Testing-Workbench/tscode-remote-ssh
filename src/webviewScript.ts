export const WEBVIEW_SCRIPT = String.raw`
/* global acquireVsCodeApi, document, window */
const vscode = acquireVsCodeApi();
let nextRequestId = 0;
const confirmationTimers = new WeakMap();
const readViewState = () => {
    try {
        const state = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
        return state && typeof state === 'object' ? state : {};
    } catch {
        return {};
    }
};
const getConfirmationKey = actionButton => String(actionButton.getAttribute('data-action')) + ':' + (actionButton.getAttribute('data-container-id') || '');
const readConfirmations = () => {
    const state = readViewState();
    return state.sidebarConfirmations && typeof state.sidebarConfirmations === 'object'
        ? state.sidebarConfirmations
        : {};
};
const writeConfirmation = (key, expiresAt) => {
    if (typeof vscode.setState !== 'function') return;
    const state = readViewState();
    const sidebarConfirmations = { ...readConfirmations(), [key]: expiresAt };
    vscode.setState({ ...state, sidebarConfirmations });
};
const clearConfirmation = (key, expectedExpiresAt) => {
    if (typeof vscode.setState !== 'function') return;
    const state = readViewState();
    const sidebarConfirmations = { ...readConfirmations() };
    if (expectedExpiresAt !== undefined && sidebarConfirmations[key] !== expectedExpiresAt) return;
    delete sidebarConfirmations[key];
    vscode.setState({ ...state, sidebarConfirmations });
};
const armConfirmation = (actionButton, expiresAt) => {
    const key = getConfirmationKey(actionButton);
    const originalHtml = actionButton.innerHTML;
    const timeoutId = window.setTimeout(() => {
        const confirmation = confirmationTimers.get(actionButton);
        if (!confirmation || confirmation.timeoutId !== timeoutId) return;
        confirmationTimers.delete(actionButton);
        clearConfirmation(key, confirmation.expiresAt);
        actionButton.innerHTML = confirmation.originalHtml;
        actionButton.classList.remove('is-confirming');
    }, Math.max(0, expiresAt - Date.now()));
    confirmationTimers.set(actionButton, { originalHtml, timeoutId, key, expiresAt });
};
const blocksConnection = action => action === 'restart' || action === 'start' || action === 'stop' || action === 'delete';
const clearActionState = actionButton => {
    if (!actionButton) return;
    actionButton.classList.remove('is-loading');
    actionButton.classList.remove('is-confirming');
    actionButton.removeAttribute('disabled');
    actionButton.removeAttribute('aria-busy');
    actionButton.removeAttribute('data-request-id');
};
const post = (command, containerId, actionButton) => {
    if (!command) return;
    const requestId = String(++nextRequestId);
    if (actionButton) actionButton.setAttribute('data-request-id', requestId);
    const fail = () => {
        clearActionState(actionButton);
        if (blocksConnection(command)) updateConnectionButtons(containerId, false);
    };
    try {
        const posted = vscode.postMessage({ command, containerId, requestId });
        if (posted && typeof posted.then === 'function') {
            posted.then(result => {
                if (result === false) fail();
            }, fail);
        }
    } catch {
        fail();
    }
    return requestId;
};
const startLoading = actionButton => {
    if (actionButton.hasAttribute('disabled') || actionButton.classList.contains('is-loading')) return false;
    actionButton.classList.add('is-loading');
    actionButton.setAttribute('disabled', '');
    actionButton.setAttribute('aria-busy', 'true');
    return true;
};
const requiresConfirmation = action => action === 'restart' || action === 'delete';
const confirmDestructiveAction = actionButton => {
    if (actionButton.hasAttribute('disabled') || actionButton.classList.contains('is-loading')) return false;
    const existingConfirmation = confirmationTimers.get(actionButton);
    if (existingConfirmation) {
        window.clearTimeout(existingConfirmation.timeoutId);
        confirmationTimers.delete(actionButton);
        clearConfirmation(existingConfirmation.key, existingConfirmation.expiresAt);
        actionButton.innerHTML = existingConfirmation.originalHtml;
        actionButton.classList.remove('is-confirming');
        return true;
    }

    const expiresAt = Date.now() + 5000;
    writeConfirmation(getConfirmationKey(actionButton), expiresAt);
    armConfirmation(actionButton, expiresAt);
    actionButton.innerHTML = '确认?';
    actionButton.classList.add('is-confirming');
    return false;
};
const updateConnectionButtons = (containerId, locked) => {
    if (!containerId) return;
    document.querySelectorAll('[data-action="connect"]').forEach(connectButton => {
        if (connectButton.getAttribute('data-container-id') !== containerId) return;
        if (locked) {
            connectButton.setAttribute('disabled', '');
            connectButton.setAttribute('aria-busy', 'true');
        } else if (connectButton.getAttribute('data-connectable') === 'true' && !connectButton.classList.contains('is-loading')) {
            connectButton.removeAttribute('disabled');
            connectButton.removeAttribute('aria-busy');
        }
    });
};
document.querySelectorAll('[data-action]').forEach(actionButton => {
    const expiresAt = Number(readConfirmations()[getConfirmationKey(actionButton)]);
    if (requiresConfirmation(actionButton.getAttribute('data-action')) && expiresAt > Date.now()) {
        armConfirmation(actionButton, expiresAt);
        actionButton.innerHTML = '确认?';
        actionButton.classList.add('is-confirming');
    }
    actionButton.addEventListener('click', () => {
        const action = actionButton.getAttribute('data-action');
        if (requiresConfirmation(action) && !confirmDestructiveAction(actionButton)) return;
        if (!startLoading(actionButton)) return;
        const containerId = actionButton.getAttribute('data-container-id');
        if (blocksConnection(action)) updateConnectionButtons(containerId, true);
        post(action, containerId, actionButton);
    });
});
document.querySelectorAll('.container-card[data-container-id]').forEach(containerCard => {
    containerCard.addEventListener('dblclick', event => {
        let target = event && event.target;
        while (target && target !== containerCard) {
            if (typeof target.getAttribute === 'function' && target.getAttribute('data-action')) return;
            target = target.parentElement;
        }
        if (containerCard.getAttribute('data-connectable') !== 'true') return;
        const containerId = containerCard.getAttribute('data-container-id');
        const connectButton = Array.from(document.querySelectorAll('[data-action="connect"]'))
            .find(button => button.getAttribute('data-container-id') === containerId);
        if (!connectButton || !startLoading(connectButton)) return;
        post('connect', containerId, connectButton);
    });
});
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'operationComplete') {
        if (message.outcome === 'busy') return;
        document.querySelectorAll('[data-action]').forEach(actionButton => {
            if (!actionButton.classList.contains('is-loading')) return;
            if (actionButton.getAttribute('data-action') !== message.action) return;
            if (typeof message.containerId === 'string' && actionButton.getAttribute('data-container-id') !== message.containerId) return;
            if (typeof message.requestId === 'string' && actionButton.getAttribute('data-request-id') !== message.requestId) return;
            if (blocksConnection(message.action) && typeof message.containerId === 'string') {
                updateConnectionButtons(message.containerId, false);
            }
            actionButton.classList.remove('is-loading');
            actionButton.removeAttribute('disabled');
            actionButton.removeAttribute('aria-busy');
            actionButton.removeAttribute('data-request-id');
        });
        return;
    }
});
`;
