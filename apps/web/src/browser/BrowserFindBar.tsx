import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { cn } from "~/lib/utils";

import { subscribeBrowserFind } from "./browserFind";

export interface SearchableBrowserWebview extends HTMLElement {
  findInPage: (query: string, options: { forward: boolean; findNext: boolean }) => number;
  stopFindInPage: (action: "clearSelection") => void;
}

interface FindResult {
  readonly requestId: number;
  readonly activeMatchOrdinal: number;
  readonly matches: number;
  readonly finalUpdate: boolean;
}

export function BrowserFindBar(props: {
  readonly tabId: string;
  readonly webviewRef: RefObject<SearchableBrowserWebview | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [status, setStatus] = useState<"searching" | "error" | null>(null);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef<number | null>(null);

  const clearSearch = () => {
    requestIdRef.current = null;
    setResult(null);
    setStatus(null);
    props.webviewRef.current?.stopFindInPage("clearSelection");
  };
  const searchPage = (text: string, initial: boolean, forward = true) => {
    const webview = props.webviewRef.current;
    if (!webview) return;
    if (!text) {
      clearSearch();
      return;
    }
    requestIdRef.current = null;
    setStatus("searching");
    if (initial) setResult(null);
    try {
      requestIdRef.current = webview.findInPage(text, { forward, findNext: initial });
    } catch {
      setResult(null);
      setStatus("error");
    }
  };
  const openFind = useEffectEvent(() => {
    if (!open && query) searchPage(query, true);
    setOpen(true);
    setFocusRequestId((id) => id + 1);
  });
  const resetFind = () => {
    setOpen(false);
    clearSearch();
  };
  const handleNavigation = useEffectEvent(resetFind);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the guest's asynchronous search results and clears its selection when the visible surface leaves
  useEffect(() => {
    const webview = props.webviewRef.current;
    if (!webview) return;
    const receiveResult = (event: Event) => {
      const found = (event as Event & { result: FindResult }).result;
      if (requestIdRef.current === null || found.requestId !== requestIdRef.current) return;
      setResult(found);
      if (found.finalUpdate) setStatus(null);
    };
    const unsubscribe = subscribeBrowserFind(props.tabId, openFind);
    webview.addEventListener("found-in-page", receiveResult);
    webview.addEventListener("did-start-loading", handleNavigation);
    return () => {
      unsubscribe();
      webview.removeEventListener("found-in-page", receiveResult);
      webview.removeEventListener("did-start-loading", handleNavigation);
      requestIdRef.current = null;
      // Closing a tab can detach the guest before React releases the search bar.
      try {
        webview.stopFindInPage("clearSelection");
      } catch {}
    };
  }, [props.tabId, props.webviewRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the search input after either find entry point opens it
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [
    open,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Repeated find shortcuts must reselect the already-open input.
    focusRequestId,
  ]);

  if (!open) return null;

  const navigationDisabled = !query || !result?.matches || status !== null;
  const closeFind = () => {
    resetFind();
    props.webviewRef.current?.focus();
  };
  const label =
    status === "error"
      ? "Search failed"
      : status === "searching"
        ? "Searching…"
        : query
          ? `${result?.activeMatchOrdinal ?? 0}/${result?.matches ?? 0}`
          : "";

  return (
    <div
      data-browser-find-bar
      className="absolute top-2 right-2 z-50 w-80 max-w-[calc(100%-1rem)]"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeFind();
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          if (!navigationDisabled) searchPage(query, false, !event.shiftKey);
        }
      }}
    >
      <InputGroup variant="popover" size="lg" role="search" aria-label="Find in page">
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={query}
          aria-label="Find in page"
          placeholder="Find in page"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const text = event.target.value;
            setQuery(text);
            searchPage(text, true);
          }}
        />
        <InputGroupAddon align="inline-end" inset="pill">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              query && !status && result?.matches === 0
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={navigationDisabled}
            onClick={() => searchPage(query, false, false)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={navigationDisabled}
            onClick={() => searchPage(query, false)}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={closeFind}>
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
