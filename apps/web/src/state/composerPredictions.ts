import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const generateComposerPrediction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "composer:predict",
  tag: WS_METHODS.composerPredict,
});
