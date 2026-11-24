import { useGT } from "gt-react";
import type {
  OrchestrationV2ProviderTurn,
  ScopedThreadRef,
  ChatAttachment,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  turnItemNeedsDetailFetch,
  turnItemDetailRevision,
  turnItemOutputImages,
} from "@t3tools/client-runtime/work-log/item-detail";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import { ChatMarkdownAssetImage } from "./ChatMarkdownMedia";
import { isImageViewTool, trajectoryImagePaths } from "./trajectory";
import { useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { isFileAttachment, isImageAttachment } from "~/types";
import { useRightPanelStore } from "~/rightPanelStore";
import { useTurnItemDetail } from "~/state/queries";
import { AttachmentImage } from "../media/AttachmentImage";
import { Button } from "../ui/button";
import { openExpandedImagePreview } from "./ExpandedImageDialog";
import { TrajectoryToolDetail } from "./TrajectoryToolDetail";
import { V2ItemInspector } from "./V2ItemInspector";
import type { TrajectoryRecord } from "./trajectory";

function TrajectoryAttachment({
  attachment,
  threadRef,
}: {
  attachment: ChatAttachment;
  threadRef: ScopedThreadRef;
}) {
  const resource = useAssetUrlState(
    threadRef.environmentId,
    isImageAttachment(attachment)
      ? {
          _tag: "attachment",
          attachmentId: attachment.id,
        }
      : null,
  );
  const label = `${attachment.name} · ${formatAttachmentSize(attachment.sizeBytes)} · ${attachment.mimeType}`;
  if (isFileAttachment(attachment))
    return (
      <button
        type="button"
        className="block break-all text-left underline"
        onClick={() => useRightPanelStore.getState().openAttachment(threadRef, attachment)}
      >
        {label}
      </button>
    );
  if (!isImageAttachment(attachment) || resource._tag !== "Success") return <p>{label}</p>;
  return (
    <button
      type="button"
      className="block break-all text-left"
      onClick={() =>
        openExpandedImagePreview(scopedThreadKey(threadRef), {
          images: [{ src: resource.url, name: attachment.name, mimeType: attachment.mimeType }],
          index: 0,
        })
      }
    >
      <AttachmentImage
        src={resource.url}
        name={attachment.name}
        mimeType={attachment.mimeType}
        alt={attachment.name}
        className="max-h-32 object-contain"
      />
      {label}
    </button>
  );
}

export function TrajectoryInspector({
  record,
  threadRef,
  workspaceRoot,
  step,
}: {
  record: TrajectoryRecord;
  threadRef: ScopedThreadRef;
  workspaceRoot: string;
  step: OrchestrationV2ProviderTurn | undefined;
}) {
  const gt = useGT();
  const { item } = record.row;
  const [raw, setRaw] = useState(false);
  const [inspectTool, setInspectTool] = useState(
    item.type === "dynamic_tool" && /(?:^|[._])(?:cua_)?run_code$/u.test(item.toolName ?? ""),
  );
  const detail = useTurnItemDetail(
    (raw || inspectTool || (item.type === "dynamic_tool" && isImageViewTool(item))) &&
      turnItemNeedsDetailFetch(item)
      ? {
          environmentId: threadRef.environmentId,
          threadId: record.row.sourceThreadId,
          itemId: record.row.sourceItemId,
          revision: turnItemDetailRevision(item),
        }
      : null,
  );
  const fullItem = detail.data?.item ?? item;
  const tool =
    fullItem.type === "command_execution" || fullItem.type === "dynamic_tool" ? fullItem : null;
  const imagePaths = fullItem.type === "dynamic_tool" ? trajectoryImagePaths(fullItem) : [];
  const usage = step?.turnTokenUsage ?? step?.tokenUsage;
  const attachments = "attachments" in item ? (item.attachments ?? []) : [];
  return (
    <section
      aria-label={gt("Record inspector")}
      className="my-1 ml-3 min-w-0 space-y-2 border-l px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-auto capitalize">{record.label}</strong>
        {tool && (
          <Button
            variant="ghost"
            size="micro"
            aria-pressed={inspectTool && !raw}
            onClick={() => {
              setInspectTool(!inspectTool);
              setRaw(false);
            }}
          >
            {gt("Tool details")}
          </Button>
        )}
        <Button variant="ghost" size="micro" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? gt("Summary") : gt("Raw record")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{item.status}</span>
        {record.start !== null && (
          <time>{gt("Start {time}", { time: new Date(record.start).toISOString() })}</time>
        )}
        {record.end !== null && (
          <time>{gt("End {time}", { time: new Date(record.end).toISOString() })}</time>
        )}
        {record.duration !== null && <span>{record.duration.toLocaleString()} ms</span>}
        {usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) && (
          <span>
            {gt("Step tokens · {input} input / {output} output", {
              input: usage.inputTokens ?? gt("unknown"),
              output: usage.outputTokens ?? gt("unknown"),
            })}
          </span>
        )}
      </div>
      {!raw &&
        imagePaths.map((path) => {
          const image = resolveViewedImageAsset(path, {
            threadId: record.row.sourceThreadId,
            workspaceRoot,
          });
          return (
            image && (
              <ChatMarkdownAssetImage
                key={path}
                environmentId={threadRef.environmentId}
                resource={image.resource}
                alt={image.alt}
                srcFragment={image.srcFragment}
                workspaceRoot={workspaceRoot}
                maxHeightRem={16}
                onImageExpand={(preview) =>
                  openExpandedImagePreview(scopedThreadKey(threadRef), preview)
                }
              />
            )
          );
        })}
      {raw ? (
        <>
          {detail.error && <p role="alert">{detail.error}</p>}
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(detail.data?.item ?? item, null, 2)}
          </pre>
        </>
      ) : inspectTool && tool ? (
        <>
          {detail.error && <p role="alert">{detail.error}</p>}
          {turnItemOutputImages(tool).map((resource) => (
            <ChatMarkdownAssetImage
              key={resource.index}
              environmentId={threadRef.environmentId}
              resource={resource}
              alt={gt("Tool output image")}
              maxHeightRem={16}
              onImageExpand={(preview) =>
                openExpandedImagePreview(scopedThreadKey(threadRef), preview)
              }
            />
          ))}
          <TrajectoryToolDetail item={tool} />
        </>
      ) : (
        <>
          {(item.type === "user_message" ||
            item.type === "assistant_message" ||
            item.type === "proposed_plan" ||
            item.type === "handoff" ||
            item.type === "compaction" ||
            item.type === "subagent") && (
            <p className="whitespace-pre-wrap break-words">{record.text}</p>
          )}
          {item.type === "subagent" && (
            <p className="whitespace-pre-wrap">{item.result ?? item.progress}</p>
          )}
          {item.type === "compaction" && item.beforeTokenCount !== undefined && (
            <p>
              {gt("Context tokens · {before} → {after}", {
                before: item.beforeTokenCount,
                after: item.afterTokenCount ?? gt("unknown"),
              })}
            </p>
          )}
          {attachments.map((a, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- An immutable attachment list can reference the same asset more than once.
            <TrajectoryAttachment key={a.id + i} threadRef={threadRef} attachment={a} />
          ))}
          <V2ItemInspector
            projectedItem={record.row}
            environmentId={threadRef.environmentId}
            workspaceRoot={workspaceRoot}
            onImageExpand={(preview) =>
              openExpandedImagePreview(scopedThreadKey(threadRef), preview)
            }
            cwd={workspaceRoot}
          />
        </>
      )}
    </section>
  );
}
