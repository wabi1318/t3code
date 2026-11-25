import * as Cause from "effect/Cause";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  deleteThread: (async () => ({ _tag: "Success" })) as (input: unknown) => Promise<unknown>,
  childThreadInputs: [] as EnvironmentThreadShell[],
  switchRef: (async () => undefined) as (input: unknown) => Promise<unknown>,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => (input: unknown) => state.switchRef(input)) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (input: unknown) => state.switchRef(input)) as never,
}));

vi.mock(import("../../hooks/useThreadActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadActions: (() => ({ deleteThread: state.deleteThread })) as never,
  useAcknowledgeThreadWoke: (() => () => undefined) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useChildThreadInputs: (() => state.childThreadInputs) as never,
}));

import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { readLocalApi } from "../../localApi";

import { render } from "../../../test/render";
import { useThreadLifecycle } from "./useThreadLifecycle";

const environmentId = EnvironmentId.make("environment:test");

function setup() {
  state.deleteThread = async () => ({ _tag: "Success" });
  state.childThreadInputs = [];
  state.switchRef = async () => undefined;
}

function threadInput(threadId: string, branch: string) {
  const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
  const thread = {
    title: "Test thread",
    id: ref.threadId,
    environmentId,
    branch,
    worktreePath: null,
  };
  return {
    routeThreadKey: scopedThreadKey(ref),
    activeThread: thread as never,
    activeThreadId: ref.threadId,
    activeThreadRef: ref,
    threadDetailRef: ref,
    activeThreadKey: scopedThreadKey(ref),
    localCheckoutBranchMismatch: { threadBranch: branch, currentBranch: "main" },
  };
}

type ThreadInput = ReturnType<typeof threadInput>;

it.each([
  { remote: false, approval: false, link: "Open question" },
  { remote: true, approval: false, link: "Open question" },
  { remote: true, approval: false, link: "Child" },
  { remote: true, approval: true, link: "Open approval" },
])("opens the child in its environment ($remote, $link)", async ({ remote, approval, link }) => {
  setup();
  const parent = threadInput("parent", "main");
  const childEnvironmentId = remote ? EnvironmentId.make("remote") : environmentId;
  state.childThreadInputs = [
    {
      id: ThreadId.make("child"),
      environmentId: childEnvironmentId,
      title: "Child",
      hasPendingApprovals: approval,
      lineage: { sideChat: false },
    } as EnvironmentThreadShell,
  ];
  await using screen = await render(
    <RestoreBranchHarness
      thread={parent}
      currentRouteThreadKeyRef={{ current: parent.routeThreadKey }}
      refreshGitStatus={() => undefined}
      focusComposer={() => undefined}
    />,
    { router: "/environment:test/parent" },
  );
  await screen.getByRole("button", { name: link, exact: true }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(
      `/${encodeURIComponent(childEnvironmentId)}/child`,
    ),
  );
});

function RestoreBranchHarness(props: {
  readonly thread: ThreadInput;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly refreshGitStatus: () => void;
  readonly focusComposer: () => void;
}) {
  const lifecycle = useThreadLifecycle({
    ...props.thread,
    environmentId,
    currentRouteThreadKeyRef: props.currentRouteThreadKeyRef,
    canOperateThread: true,
    clientSettingsHydrated: true,
    activeThreadShell: props.thread.activeThread as never,
    limitRecoveryHoldsSnooze: false,
    activeLatestRun: null as never,
    activeProjectCwd: "/repo",
    serverConfig: null,
    runtimeMode: "full-access" as never,
    isWorking: false,
    runIsLive: false,
    pendingBackgroundTasks: [{ taskId: "background-command", kind: "command" }] as never,
    turnItems: [],
    activePendingApproval: null as never,
    activePendingUserInput: null as never,
    gitStatusQuery: { refresh: props.refreshGitStatus },
    nowMinute: "",
    composerRef: { current: { focusAtEnd: props.focusComposer } } as never,
    composerDraftTarget: { kind: "thread", ref: props.thread.activeThreadRef } as never,
    sendInFlightRef: { current: false },
    setOptimisticUserMessages: () => undefined,
    setThreadError: () => undefined,
    clearUsageLimitsFor: () => undefined,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    scrollToEnd: () => undefined,
    persistThreadSettingsForNextTurn: async () => ({ _tag: "Success", value: undefined }) as never,
  });
  return (
    <>
      {lifecycle.childInputNow?.description}
      {lifecycle.childInputNow?.actions}
      {lifecycle.workNow?.actions}
      <button
        onClick={() =>
          lifecycle.shortcuts["thread.delete"]({
            event: new KeyboardEvent("keydown"),
            terminalFocusOwner: null,
          })
        }
      >
        Delete shortcut
      </button>
      <button
        type="button"
        disabled={lifecycle.isRestoringThreadBranch}
        onClick={lifecycle.handleSwitchCheckoutToThreadStable}
      >
        {lifecycle.isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
      </button>
    </>
  );
}

it.each(["a", "b", "navigation"] as const)(
  "isolates restore completion and queued focus for %s",
  async (scenario) => {
    const first = scenario === "b" ? "b" : "a";
    setup();
    const completions: Array<(result: unknown) => void> = [];
    const switchRef = vi.fn(() => new Promise<unknown>((resolve) => completions.push(resolve)));
    state.switchRef = switchRef;
    const threadA = threadInput("thread:a", "feature-a");
    const threadB = threadInput("thread:b", "feature-b");
    const currentRouteThreadKeyRef = { current: threadA.routeThreadKey };
    const refreshGitStatus = vi.fn();
    const focusComposer = vi.fn();
    const harness = (thread: ThreadInput) => (
      <RestoreBranchHarness
        thread={thread}
        currentRouteThreadKeyRef={currentRouteThreadKeyRef}
        refreshGitStatus={refreshGitStatus}
        focusComposer={focusComposer}
      />
    );
    await using screen = await render(harness(threadA));
    const focusFrames: FrameRequestCallback[] = [];
    using _frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      focusFrames.push(callback);
      return 0;
    });

    await page.getByRole("button", { name: "Restore branch" }).click();
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();

    // ChatView stays mounted across server threads, so the hook sees thread B in place.
    currentRouteThreadKeyRef.current = threadB.routeThreadKey;
    await screen.rerender(harness(threadB));
    await expect.element(page.getByRole("button", { name: "Restore branch" })).toBeEnabled();
    await page.getByRole("button", { name: "Restore branch" }).click();
    expect(switchRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { cwd: "/repo", refName: "feature-b" } }),
    );

    // Back on thread A, its own restore is still pending, so it can't start a second one.
    currentRouteThreadKeyRef.current = threadA.routeThreadKey;
    await screen.rerender(harness(threadA));
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();
    currentRouteThreadKeyRef.current = threadB.routeThreadKey;
    await screen.rerender(harness(threadB));

    const completed = first === "a" ? threadA : threadB;
    const pending = first === "a" ? threadB : threadA;
    currentRouteThreadKeyRef.current = pending.routeThreadKey;
    await screen.rerender(harness(pending));
    completions[first === "a" ? 0 : 1]!({
      _tag: "Success",
      value: { refName: completed.localCheckoutBranchMismatch.threadBranch },
    });
    await vi.waitFor(() => expect(refreshGitStatus).toHaveBeenCalledOnce());
    expect(focusComposer).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Restoring..." })).toBeDisabled();
    expect(switchRef).toHaveBeenCalledTimes(2);

    completions[first === "a" ? 1 : 0]!({
      _tag: "Success",
      value: { refName: pending.localCheckoutBranchMismatch.threadBranch },
    });
    await expect.element(page.getByRole("button", { name: "Restore branch" })).toBeEnabled();
    expect(refreshGitStatus).toHaveBeenCalledTimes(2);
    expect(focusComposer).not.toHaveBeenCalled();
    expect(focusFrames).toHaveLength(1);
    if (scenario === "navigation") {
      currentRouteThreadKeyRef.current = completed.routeThreadKey;
      await screen.rerender(harness(completed));
    }
    focusFrames[0]!(0);
    expect(focusComposer).toHaveBeenCalledTimes(scenario === "navigation" ? 0 : 1);
  },
);

it.each(["Success", "Failure"] as const)(
  "keeps background stop requests per thread after %s",
  async (outcome) => {
    setup();
    const completions: Array<(result: unknown) => void> = [];
    state.switchRef = vi.fn(() => new Promise((resolve) => completions.push(resolve)));
    const threadA = threadInput("thread:a", "feature-a");
    const threadB = threadInput("thread:b", "feature-b");
    const currentRouteThreadKeyRef = { current: threadA.routeThreadKey };
    const harness = (thread: ThreadInput) => (
      <RestoreBranchHarness
        thread={thread}
        currentRouteThreadKeyRef={currentRouteThreadKeyRef}
        refreshGitStatus={() => undefined}
        focusComposer={() => undefined}
      />
    );
    await using screen = await render(harness(threadA));
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    await screen.rerender(harness(threadB));
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await screen.rerender(harness(threadA));
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    completions[0]!(
      outcome === "Success"
        ? { _tag: "Success", value: undefined }
        : { _tag: "Failure", cause: Cause.fail(new Error("stop failed")) },
    );
    if (outcome === "Success") {
      await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    } else {
      await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    }
    await screen.rerender(harness(threadB));
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    expect(state.switchRef).toHaveBeenCalledTimes(2);
    completions[1]!({ _tag: "Success", value: undefined });
  },
);

it.each([false, true, "failure"] as const)(
  "requires confirmation before deleting a thread: %s",
  async (answer) => {
    setup();
    let resolveConfirmation!: (answer: boolean) => void;
    let rejectConfirmation!: (error: Error) => void;
    const confirmation = new Promise<boolean>((resolve, reject) => {
      resolveConfirmation = resolve;
      rejectConfirmation = reject;
    });
    const remove = vi.fn(async () => ({ _tag: "Success" }));

    state.deleteThread = remove;
    const thread = threadInput("thread:delete", "main");
    await using screen = await render(
      <RestoreBranchHarness
        thread={thread}
        currentRouteThreadKeyRef={{ current: thread.routeThreadKey }}
        refreshGitStatus={() => {}}
        focusComposer={() => {}}
      />,
    );
    using confirm = vi.spyOn(readLocalApi()!.dialogs, "confirm").mockReturnValue(confirmation);
    await screen.getByRole("button", { name: "Delete shortcut" }).click();
    await screen.getByRole("button", { name: "Delete shortcut" }).click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("Test thread");
    expect(remove).not.toHaveBeenCalled();
    if (answer === "failure") rejectConfirmation(new Error("Confirmation unavailable"));
    else resolveConfirmation(answer);
    await confirmation.catch(() => false);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(answer === true ? 1 : 0));
    if (answer === true) expect(remove).toHaveBeenCalledWith(thread.activeThreadRef);
  },
);

it.each(["Enter", "Escape"])(
  "handles %s after opening thread deletion from the shortcut",
  async (key) => {
    setup();
    const remove = vi.fn(async () => ({ _tag: "Success" }));
    state.deleteThread = remove;
    const thread = threadInput("thread:delete-enter", "main");
    await using screen = await render(
      <>
        <ConfirmDialogHost />
        <RestoreBranchHarness
          thread={thread}
          currentRouteThreadKeyRef={{ current: thread.routeThreadKey }}
          refreshGitStatus={() => {}}
          focusComposer={() => {}}
        />
      </>,
    );
    await screen.getByRole("button", { name: "Delete shortcut" }).click();
    await expect.element(page.getByRole("button", { name: "Confirm", exact: true })).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await userEvent.keyboard(`{${key}}`);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(key === "Enter" ? 1 : 0);
    if (key === "Enter") expect(remove).toHaveBeenCalledWith(thread.activeThreadRef);
  },
);
