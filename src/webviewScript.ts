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
document.querySelectorAll('[data-action]').forEach(actionButton => {
    actionButton.addEventListener('click', () => {
        if (!startLoading(actionButton)) return;
        post(actionButton.getAttribute('data-action'), actionButton.getAttribute('data-container-id'));
    });
});
document.querySelectorAll('.service-heading').forEach(serviceHeading => {
    serviceHeading.addEventListener('dblclick', () => {
        post('connect', serviceHeading.getAttribute('data-container-id'));
    });
});
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'operationComplete') {
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
