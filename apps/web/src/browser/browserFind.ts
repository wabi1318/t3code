const BROWSER_FIND_EVENT = "t3code:browser-find";

export function openBrowserFind(tabId: string): void {
  window.dispatchEvent(new CustomEvent(BROWSER_FIND_EVENT, { detail: tabId }));
}

export function subscribeBrowserFind(tabId: string, open: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<unknown>).detail === tabId) open();
  };
  window.addEventListener(BROWSER_FIND_EVENT, listener);
  return () => {
    window.removeEventListener(BROWSER_FIND_EVENT, listener);
  };
}
