export const WEBVIEW_SCRIPT = String.raw`
/* global acquireVsCodeApi, document, window */
const vscode = acquireVsCodeApi();
const post = (command, containerId) => {
    if (!command) return;
    vscode.postMessage({ command, containerId });
};
const startLoading = actionButton => {
    if (actionButton.hasAttribute('disabled') || actionButton.classList.contains('is-loading')) return false;
    actionButton.classList.add('is-loading');
    actionButton.setAttribute('disabled', '');
    actionButton.setAttribute('aria-busy', 'true');
    return true;
};
const blocksConnection = action => action === 'restart' || action === 'start' || action === 'stop' || action === 'delete';
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
    actionButton.addEventListener('click', () => {
        if (!startLoading(actionButton)) return;
        const action = actionButton.getAttribute('data-action');
        const containerId = actionButton.getAttribute('data-container-id');
        if (blocksConnection(action)) updateConnectionButtons(containerId, true);
        post(action, containerId);
    });
});
document.querySelectorAll('.container-card[data-container-id]').forEach(containerCard => {
    containerCard.addEventListener('dblclick', () => {
        if (containerCard.getAttribute('data-connectable') !== 'true') return;
        const containerId = containerCard.getAttribute('data-container-id');
        const connectButton = Array.from(document.querySelectorAll('[data-action="connect"]'))
            .find(button => button.getAttribute('data-container-id') === containerId);
        if (!connectButton || !startLoading(connectButton)) return;
        post('connect', containerId);
    });
});
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'operationComplete') {
        if (blocksConnection(message.action) && typeof message.containerId === 'string') {
            updateConnectionButtons(message.containerId, false);
        }
        document.querySelectorAll('[data-action]').forEach(actionButton => {
            if (!actionButton.classList.contains('is-loading')) return;
            if (actionButton.getAttribute('data-action') !== message.action) return;
            if (typeof message.containerId === 'string' && actionButton.getAttribute('data-container-id') !== message.containerId) return;
            actionButton.classList.remove('is-loading');
            actionButton.removeAttribute('disabled');
            actionButton.removeAttribute('aria-busy');
        });
        return;
    }
});
`;
