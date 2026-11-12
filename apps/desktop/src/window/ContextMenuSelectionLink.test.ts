import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { createContextMenuSelectionLink } from "./ContextMenuSelectionLink.ts";

function createFrame(href: string, pageGlobals: Record<string, unknown> = {}) {
  const selection = { isCollapsed: false, rangeCount: 1 };
  const generateDirective = vi.fn(async () => "text=Later-,repeated%20phrase,-there.");
  const frame = {
    url: href,
    isDestroyed: vi.fn(() => false),
    executeJavaScript: async (script: string): Promise<unknown> =>
      NodeVM.runInNewContext(script, {
        URL,
        location: { href },
        document: {
          getSelection: () => selection,
          fragmentDirective: { createSelectorDirective: generateDirective },
        },
        ...pageGlobals,
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

it.each([
  ["javascript:alert(1)", null],
  ["data:text/html,selected", null],
  ["not a URL", null],
  ["https://attacker.example/article#:~:text=selected", null],
  ["http://example.com/article#:~:text=selected", null],
  ["https://example.com/other#:~:text=selected", null],
  ["https://example.com/article?other=true#:~:text=selected", null],
  [
    Object.assign(new URL("https://example.com/article#:~:text=selected"), {
      username: "test-user",
    }).href,
    null,
  ],
  [
    "https://example.com:443/article#:~:text=selected",
    "https://example.com/article#:~:text=selected",
  ],
  [
    "https://exam\nple.com/article#:~:text=selected",
    "https://example.com/article#:~:text=selected",
  ],
])("validates page-supplied selection links: %s", async (forgedLink, expected) => {
  const { frame } = createFrame("https://example.com/article", {
    URL: class {
      protocol = "https:";
      hash = "";
      href = forgedLink;
    },
  });
  expect(await createContextMenuSelectionLink(frame)).toBe(expected);
});

it.each([
  ["https://example.com/another-page", null],
  ["https://example.com/article#section", "https://example.com/article#:~:text=selected"],
] as const)(
  "checks the current source page after navigation to %s",
  async (currentUrl, expected) => {
    const { frame, generateDirective } = createFrame("https://example.com/article");
    generateDirective.mockImplementation(async () => {
      frame.url = currentUrl;
      return "text=selected";
    });
    expect(await createContextMenuSelectionLink(frame)).toBe(expected);
  },
);

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
