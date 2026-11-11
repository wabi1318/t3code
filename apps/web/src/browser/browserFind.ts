const BROWSER_FIND_EVENT = "t3code:browser-find";

export function openBrowserFind(tabId: string): void {
  window.dispatchEvent(new CustomEvent(BROWSER_FIND_EVENT, { detail: tabId }));
}

export function subscribeBrowserFind(tabId: string, open: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<unknown>).detail === tabId) open();
  };
  window.addEventListener(BROWSER_FIND_EVENT, listener);
  const unsubscribe = window.desktopBridge?.onMenuAction((action, previewTabId) => {
    if (action === "preview.find" && previewTabId === tabId) open();
  });
  return () => {
    window.removeEventListener(BROWSER_FIND_EVENT, listener);
    unsubscribe?.();
  };
}
