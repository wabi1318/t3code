import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { BrowserFindBar } from "./BrowserFindBar";
import { openBrowserFind } from "./browserFind";

function createWebview() {
  let requestId = 0;
  const findInPage = vi.fn(() => ++requestId);
  const stopFindInPage = vi.fn();
  const webview = Object.assign(document.createElement("div"), { findInPage, stopFindInPage });
  webview.tabIndex = 0;
  return {
    ref: { current: webview },
    findInPage,
    stopFindInPage,
    result: (id: number, matches: number, activeMatchOrdinal = 1, finalUpdate = true) =>
      webview.dispatchEvent(
        Object.assign(new Event("found-in-page"), {
          result: { requestId: id, matches, activeMatchOrdinal, finalUpdate },
        }),
      ),
  };
}

describe("BrowserFindBar", () => {
  it("uses only the latest request's results and navigates matches until search closes", async () => {
    const guest = createWebview();
    await using screen = await render(<BrowserFindBar tabId="tab-a" webviewRef={guest.ref} />);
    screen.container.append(guest.ref.current);
    await act(() => openBrowserFind("tab-a"));
    const input = screen.getByRole("searchbox", { name: "Find in page" });
    await expect.element(input).toHaveFocus();
    await input.fill("a");
    const earlierRequest = guest.findInPage.mock.results.at(-1)!.value;
    await input.fill("needle");
    const latestRequest = guest.findInPage.mock.results.at(-1)!.value;
    expect(guest.findInPage).toHaveBeenLastCalledWith("needle", { forward: true, findNext: true });

    await act(() => guest.result(earlierRequest, 99));
    await expect.element(screen.getByText("Searching…")).toBeVisible();
    await act(() => guest.result(latestRequest, 3));
    await expect.element(screen.getByText("1/3")).toBeVisible();
    await act(() => openBrowserFind("tab-a"));
    expect((input.element() as HTMLInputElement).selectionStart).toBe(0);
    expect((input.element() as HTMLInputElement).selectionEnd).toBe("needle".length);
    await userEvent.keyboard("{Enter}");
    expect(guest.findInPage).toHaveBeenLastCalledWith("needle", { forward: true, findNext: false });
    await act(() => guest.result(guest.findInPage.mock.results.at(-1)!.value, 3, 2));
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(guest.findInPage).toHaveBeenLastCalledWith("needle", {
      forward: false,
      findNext: false,
    });

    await act(() => guest.result(guest.findInPage.mock.results.at(-1)!.value, 3));
    await userEvent.keyboard("{Escape}");
    await expect.element(input).not.toBeInTheDocument();
    expect(guest.stopFindInPage).toHaveBeenLastCalledWith("clearSelection");
    expect(document.activeElement).toBe(guest.ref.current);
    await act(() => guest.result(latestRequest, 99));
    await act(() => openBrowserFind("tab-a"));
    await expect.element(input).toHaveValue("needle");
    await expect.element(screen.getByText("Searching…")).toBeVisible();

    await input.fill("");
    expect(guest.stopFindInPage).toHaveBeenLastCalledWith("clearSelection");
    await expect.element(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
  });

  it("keeps native find requests in their tab and clears a search on navigation or removal", async () => {
    const listeners = new Set<(action: string, previewTabId?: string) => void>();
    using stack = new DisposableStack();
    vi.stubGlobal("desktopBridge", {
      onMenuAction: (listener: (action: string, previewTabId?: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    stack.defer(() => vi.unstubAllGlobals());
    const first = createWebview();
    const second = createWebview();
    await using screen = await render(
      <>
        <BrowserFindBar tabId="tab-a" webviewRef={first.ref} />
        <BrowserFindBar tabId="tab-b" webviewRef={second.ref} />
      </>,
    );
    await act(() => {
      for (const listener of listeners) listener("preview.find", "tab-b");
    });
    const input = screen.getByRole("searchbox", { name: "Find in page" });
    await input.fill("日本語");
    expect(first.findInPage).not.toHaveBeenCalled();
    expect(second.findInPage).toHaveBeenLastCalledWith("日本語", {
      forward: true,
      findNext: true,
    });
    await act(() => second.result(1, 2));
    await act(() => {
      input
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
        );
    });
    expect(second.findInPage).toHaveBeenCalledOnce();
    await act(() => second.ref.current.dispatchEvent(new Event("did-start-loading")));
    await expect.element(input).not.toBeInTheDocument();
    expect(second.stopFindInPage).toHaveBeenCalledWith("clearSelection");

    await act(() => openBrowserFind("tab-a"));
    await input.fill("absent");
    await act(() => first.result(1, 0, 0));
    await expect.element(screen.getByText("0/0")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    await screen.unmount();
    expect(first.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(listeners.size).toBe(0);
  });
});
