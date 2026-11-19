import type { StaticScreenProps } from "@react-navigation/native";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { AddProjectLocalFolderScreen } from "./AddProjectScreen";

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[];
  readonly workspaceSwitch?: {
    readonly threadId: ThreadId;
    readonly sourceProjectId: ProjectId;
  };
};

export function AddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>) {
  return <AddProjectLocalFolderScreen {...(route.params ?? {})} />;
}
