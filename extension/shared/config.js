/** Defaults; override via chrome.storage.sync from side panel. */
export const DEFAULT_CONFIG = {
  apiBaseUrl: 'http://127.0.0.1:8787',
  apiToken: 'dev-extension-token-change-me',
  pageSettleMs: 2500,
  pageTimeoutMs: 45000,
};

export async function loadConfig() {
  const stored = await chrome.storage.sync.get(['apiBaseUrl', 'apiToken', 'pageSettleMs']);
  return {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(
      Object.entries(stored).filter(([, v]) => v !== undefined && v !== '')
    ),
  };
}
