import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { createContextMenuSelectionLink } from "./ContextMenuSelectionLink.ts";

function createFrame(href: string) {
  const selection = { isCollapsed: false, rangeCount: 1 };
  const generateDirective = vi.fn(async () => "text=Later-,repeated%20phrase,-there.");
  const frame = {
    isDestroyed: vi.fn(() => false),
    executeJavaScript: async (script: string): Promise<unknown> =>
      NodeVM.runInNewContext(script, {
        URL,
        location: { href },
        document: {
          getSelection: () => selection,
          fragmentDirective: { createSelectorDirective: generateDirective },
        },
      }),
  };
  return { frame, selection, generateDirective };
}

it.each([
  [
    "https://example.com/article?q=test",
    "https://example.com/article?q=test#:~:text=Later-,repeated%20phrase,-there.",
  ],
  [
    "https://example.com/article#section",
    "https://example.com/article#section:~:text=Later-,repeated%20phrase,-there.",
  ],
  [
    "https://example.com/article#section:~:text=old",
    "https://example.com/article#section:~:text=Later-,repeated%20phrase,-there.",
  ],
])("creates a link to the selected occurrence from %s", async (href, expected) => {
  const { frame } = createFrame(href);
  expect(await createContextMenuSelectionLink(frame)).toBe(expected);
});

it.each(["about:blank", "file:///article.html", "data:text/html,article"])(
  "does not create a shareable selection link for %s",
  async (href) => {
    const { frame } = createFrame(href);
    expect(await createContextMenuSelectionLink(frame)).toBeNull();
  },
);

it.each(["collapsed", "no ranges", "closed frame"])(
  "does not create a link for a selection with %s",
  async (state) => {
    const { frame, selection } = createFrame("https://example.com/article");
    if (state === "collapsed") selection.isCollapsed = true;
    if (state === "no ranges") selection.rangeCount = 0;
    if (state === "closed frame") frame.isDestroyed.mockReturnValue(true);
    expect(await createContextMenuSelectionLink(frame)).toBeNull();
  },
);

it("drops the generated link if its source frame closes", async () => {
  const { frame, generateDirective } = createFrame("https://example.com/article");
  generateDirective.mockImplementation(async () => {
    frame.isDestroyed.mockReturnValue(true);
    return "text=selected";
  });
  expect(await createContextMenuSelectionLink(frame)).toBeNull();
});
