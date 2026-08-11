// Renderer for the Bridge Info window. Runs in the sandboxed page; all
// privileged operations go through window.bridgeInfoApi (see
// bridge-info-preload.cjs).
(function () {
  const api = window.bridgeInfoApi;
  if (!api) {
    document.getElementById('status').textContent = 'Bridge API unavailable';
    return;
  }

  const statusEl = document.getElementById('status');
  const urlEl = document.getElementById('url');
  const tokenEl = document.getElementById('token');
  const errorEl = document.getElementById('error');
  const copyUrlButton = document.getElementById('copy-url');
  const copyTokenButton = document.getElementById('copy-token');

  function render(info) {
    if (!info) return;
    urlEl.textContent = info.url || '—';
    tokenEl.textContent = info.token || '—';
    statusEl.textContent = info.running ? 'Running' : 'Stopped';
    statusEl.className = 'pill ' + (info.running ? 'ok' : 'warn');
    // The URL only exists while the bridge is bound to a port (startBridge
    // failed => url: null) — never offer to copy a placeholder.
    copyUrlButton.disabled = !info.url;
    copyTokenButton.disabled = !info.token;
  }

  // Electron prefixes IPC handler rejections with
  // "Error invoking remote method '<channel>':" — strip it for display.
  function errorMessage(error) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  api
    .get()
    .then(render)
    .catch((error) =>
      showError('Could not load bridge info: ' + errorMessage(error))
    );
  api.onChanged((info) => {
    // A push showing the bridge running again (e.g. a successful token
    // reset from the menu) resolves any previously shown reset error.
    if (info && info.running) clearError();
    render(info);
  });

  function wire(button, textGetter) {
    button.addEventListener('click', () => {
      const text = textGetter();
      if (!text) return;
      api
        .copyText(text)
        .then(() => {
          // A successful copy resolves any previously shown copy error.
          clearError();
          const original = button.textContent;
          button.textContent = 'Copied ✓';
          setTimeout(() => {
            button.textContent = original;
          }, 1200);
        })
        .catch((error) => {
          showError('Copy failed: ' + errorMessage(error));
        });
    });
  }

  wire(copyUrlButton, () => urlEl.textContent);
  wire(copyTokenButton, () => tokenEl.textContent);

  document.getElementById('reset').addEventListener('click', () => {
    clearError();
    api
      .reset()
      .then(render)
      .catch((error) => {
        // The main process has already pushed the real (now stopped)
        // bridge state via bridge:changed — surface *why* the reset
        // failed instead of silently keeping the stale display.
        showError('Reset failed: ' + errorMessage(error));
      });
  });
})();
