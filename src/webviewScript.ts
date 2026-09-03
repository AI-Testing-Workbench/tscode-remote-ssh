export const WEBVIEW_SCRIPT = String.raw`
/* global acquireVsCodeApi, document */
const vscode = acquireVsCodeApi();
const post = (command, containerId) => {
    if (!command) return;
    vscode.postMessage({ command, containerId });
};
document.querySelectorAll('[data-action]').forEach(actionButton => {
    actionButton.addEventListener('click', () => {
        if (actionButton.hasAttribute('disabled')) return;
        post(actionButton.getAttribute('data-action'), actionButton.getAttribute('data-container-id'));
    });
});
document.querySelectorAll('.service-heading').forEach(serviceHeading => {
    serviceHeading.addEventListener('dblclick', () => {
        post('connect', serviceHeading.getAttribute('data-container-id'));
    });
});
`;
