import type * as Electron from "electron";

export async function createContextMenuSelectionLink(
  frame: Pick<Electron.WebFrameMain, "isDestroyed" | "executeJavaScript">,
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
  return typeof link === "string" && !frame.isDestroyed() ? link : null;
}
