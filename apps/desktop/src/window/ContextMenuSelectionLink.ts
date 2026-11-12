import type * as Electron from "electron";

export async function createContextMenuSelectionLink(
  frame: Pick<Electron.WebFrameMain, "isDestroyed" | "executeJavaScript" | "url">,
): Promise<string | null> {
  if (frame.isDestroyed()) return null;
  const link = await frame.executeJavaScript(`(async () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const url = new URL(location.href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const directive = await document.fragmentDirective.createSelectorDirective(selection);
    url.hash = url.hash.split(":~:")[0] + ":~:" + directive.toString();
    return url.href;
  })()`);
  if (typeof link !== "string" || frame.isDestroyed()) return null;
  const sourceUrl = URL.parse(frame.url);
  const selectionUrl = URL.parse(link);
  if (
    !sourceUrl ||
    !selectionUrl ||
    (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:")
  ) {
    return null;
  }
  const selectionHref = selectionUrl.href;
  sourceUrl.hash = "";
  selectionUrl.hash = "";
  return selectionUrl.href === sourceUrl.href ? selectionHref : null;
}
