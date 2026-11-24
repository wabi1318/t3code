import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { assistantItem } from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { trajectoryRecord } from "./trajectory";
import { TrajectoryInspector } from "./TrajectoryInspector";

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (environmentId, resource) => {
    if (
      environmentId !== "fixture" ||
      resource?._tag !== "media-file" ||
      resource.threadId !== "source" ||
      !resource.path.endsWith("reference.gif")
    )
      return { _tag: "Failure" };
    return {
      _tag: "Success",
      url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  },
}));

it.each([true, false])(
  "displays a viewed image in its source environment (recorded path: %s)",
  async (recordedPath) => {
    const sourceThreadId = ThreadId.make("source");
    const base = assistantItem(sourceThreadId, RunId.make("run"), "image", 1, "");
    const path = "/repo/reference.gif";
    const record = trajectoryRecord({
      sourceThreadId,
      sourceItemId: base.id,
      position: 1,
      visibility: "inherited",
      item: {
        ...base,
        type: "dynamic_tool",
        toolName: recordedPath ? "view_image" : "view_images",
        input: recordedPath ? { path } : { paths: [path] },
        ...(recordedPath ? { viewedImagePath: path } : {}),
      },
    });
    await using screen = await render(
      <TrajectoryInspector
        record={record}
        threadRef={{
          environmentId: EnvironmentId.make("fixture"),
          threadId: ThreadId.make("active"),
        }}
        workspaceRoot="/repo"
        step={undefined}
      />,
    );
    const image = screen.getByAltText("reference.gif");
    await expect.element(image).toBeVisible();
    await vi.waitFor(() => expect(image.element()).toHaveProperty("naturalWidth", 1));
  },
);
