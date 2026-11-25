import { useGT } from "gt-react";
import { useState } from "react";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { Button } from "../ui/button";

function parseRecordedValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ValueTree({ value, label }: { value: unknown; label: string }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  if (value === null || typeof value !== "object")
    return (
      <div className="whitespace-pre-wrap break-all">
        <b>{label}</b> {String(value)}
      </div>
    );
  const entries = Object.entries(value);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer">
        {label} · {entries.length} {Array.isArray(value) ? gt("items") : gt("fields")}
      </summary>
      {open && (
        <div className="ml-2 border-l pl-2">
          {entries.map(([key, child]) => (
            <ValueTree key={key} value={child} label={key} />
          ))}
        </div>
      )}
    </details>
  );
}

export function TrajectoryToolDetail({
  item,
}: {
  item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" | "command_execution" }>;
}) {
  const gt = useGT();
  const theme = useRenderedAppearance();
  const [view, setView] = useState<"source" | "arguments" | "result">("source");
  const args = parseRecordedValue(item.input);
  const program =
    item.type === "command_execution"
      ? item.input
      : typeof args === "object" && args !== null && "code" in args && typeof args.code === "string"
        ? args.code
        : null;
  const source = view === "source" && program !== null;
  const result = view === "result";
  const value = result ? item.output : item.input;
  const text = source
    ? program
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
  if (text === undefined)
    return (
      <div>
        <Button size="micro" variant="ghost" onClick={() => setView("arguments")}>
          {gt("Input")}
        </Button>
        <p>
          {item.outputOmitted
            ? gt("Output details are unavailable.")
            : item.status === "running"
              ? gt("Awaiting output…")
              : gt("No recorded output.")}
        </p>
      </div>
    );
  return (
    <div className="chat-markdown space-y-1">
      <div className="flex flex-wrap gap-1">
        {program !== null && (
          <Button
            size="micro"
            variant="ghost"
            aria-pressed={source}
            onClick={() => setView("source")}
          >
            {gt("Code")}
          </Button>
        )}
        <Button
          size="micro"
          variant="ghost"
          aria-pressed={!result && !source}
          onClick={() => setView("arguments")}
        >
          {gt("Input")}
        </Button>
        <Button
          size="micro"
          variant="ghost"
          aria-pressed={result}
          onClick={() => setView("result")}
        >
          {gt("Output")}
        </Button>
      </div>
      {result && item.status !== "failed" && <ValueTreeRoot value={item.output} />}
      <MarkdownCodeBlock
        code={text}
        language=""
        fenceTitle={source ? gt("Code") : result ? gt("Output") : gt("Input")}
        theme={theme}
        isStreaming={false}
      >
        <pre className="max-h-80 overflow-auto px-2 py-1">
          <code>
            {source
              ? text.split("\n").map((line, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Each displayed source line is identified by its line number.
                  <span key={index} className="block">
                    <span aria-hidden="true" className="mr-3 select-none text-muted-foreground">
                      {index + 1}
                    </span>
                    {line}
                  </span>
                ))
              : text}
          </code>
        </pre>
      </MarkdownCodeBlock>
    </div>
  );
}

function ValueTreeRoot({ value }: { value: unknown }) {
  const gt = useGT();
  const parsed = parseRecordedValue(value);
  return parsed !== null && typeof parsed === "object" ? (
    <ValueTree value={parsed} label={gt("Explore JSON")} />
  ) : null;
}
