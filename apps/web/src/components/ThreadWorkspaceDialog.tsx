import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { FolderIcon } from "lucide-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, useProjects, useThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { getEnvironmentBrowsePlatform } from "./CommandPalette.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

const useWorkspaceDialog = create<{ target: ScopedThreadRef | null }>(() => ({ target: null }));

export function canSwitchThreadWorkspace(target: ScopedThreadRef): boolean {
  const thread = readThreadShell(target);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId);
  return Boolean(
    thread &&
    !thread.archivedAt &&
    !thread.lineage.sideChat &&
    config?.environment.capabilities.threadWorkspaceSwitch,
  );
}

export function openThreadWorkspaceDialog(target: ScopedThreadRef) {
  useWorkspaceDialog.setState({ target });
}

function closeThreadWorkspaceDialog() {
  useWorkspaceDialog.setState({ target: null });
}

export function ThreadWorkspaceDialogHost() {
  const target = useWorkspaceDialog((state) => state.target);
  return target ? <ThreadWorkspaceDialog key={target.threadId} target={target} /> : null;
}

function ThreadWorkspaceDialog({ target }: { readonly target: ScopedThreadRef }) {
  const pathId = useId();
  const thread = useThreadShell(target);
  const [sourceProjectId] = useState(() => thread?.projectId ?? null);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === target.environmentId,
  );
  const projectChoices = projects.filter(
    (project) =>
      project.environmentId === target.environmentId &&
      project.archivedAt == null &&
      !project.isScratch &&
      (project.id !== thread?.projectId || thread.worktreePath !== null),
  );
  const canSwitch = useAtomValue(
    projectEnvironment.switchThreadWorkspace.permissionAtom(target.environmentId),
  );
  const switchWorkspace = useAtomCommand(projectEnvironment.switchThreadWorkspace, {
    reportFailure: false,
  });
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browseAccess = useFilesystemReadAccess(target.environmentId);
  const browse = getFilesystemBrowsePath(
    path,
    getEnvironmentBrowsePlatform(environment?.serverConfig?.environment.platform.os),
  );
  const directories = useEnvironmentQuery(
    browseAccess.canReadFiles && browse.directoryPath
      ? filesystemEnvironment.browse({
          environmentId: target.environmentId,
          input: { partialPath: browse.directoryPath },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    directories.data?.entries ?? [],
    browse.filterQuery,
  );
  const workspaceRoot = exactEntry?.fullPath ?? path.trim();

  const submit = async () => {
    if (!canSwitch || !sourceProjectId || !workspaceRoot || submitting) return;
    setError(null);
    setSubmitting(true);
    const result = await switchWorkspace({
      environmentId: target.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        threadId: target.threadId,
        sourceProjectId,
        workspaceRoot,
        moveScheduledTasks: true,
      },
    });
    if (result._tag === "Success") {
      closeThreadWorkspaceDialog();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not switch folders.");
    }
    setSubmitting(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) closeThreadWorkspaceDialog();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Switch working folder</DialogTitle>
          <DialogDescription>
            The next turn and any scheduled tasks attached to this thread will run in the selected
            folder. Your conversation stays here and files stay in their current folders.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={pathId + "-form"}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor={pathId}>Working folder</Label>
            <div className="mt-1 flex gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  id={pathId}
                  value={path}
                  onChange={(event) => {
                    setError(null);
                    setPath(event.target.value);
                  }}
                  placeholder="Path on this machine"
                  disabled={submitting}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!browseAccess.canReadFiles || submitting}
                onClick={() => setPath("~/")}
              >
                Browse
              </Button>
            </div>
            <div className="mt-2 max-h-56 overflow-auto">
              {!browse.isBrowsing ? (
                projectChoices.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    disabled={submitting}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => setPath(project.workspaceRoot)}
                  >
                    <FolderIcon className="size-4 shrink-0" />
                    <span className="truncate">{project.title}</span>
                    <span className="truncate text-muted-foreground">{project.workspaceRoot}</span>
                  </button>
                ))
              ) : (
                <>
                  {browse.canBrowseUp && browse.parentPath !== null ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={submitting}
                      onClick={() => setPath(ensureBrowseDirectoryPath(browse.parentPath ?? "~/"))}
                    >
                      Parent folder
                    </Button>
                  ) : null}
                  {visibleEntries.map((entry) => (
                    <button
                      key={entry.fullPath}
                      type="button"
                      disabled={submitting}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => setPath(ensureBrowseDirectoryPath(entry.fullPath))}
                    >
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
            {(error ?? directories.error) ? (
              <p role="alert" className="mt-2 text-destructive text-sm">
                {error ?? directories.error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={closeThreadWorkspaceDialog}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={pathId + "-form"}
            disabled={!canSwitch || !sourceProjectId || !workspaceRoot || submitting}
          >
            {submitting ? "Switching folder…" : "Switch folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
