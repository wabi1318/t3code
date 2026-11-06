import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";

export const ComposerPredictionInput = Schema.Struct({ threadId: ThreadId, runId: RunId });
export type ComposerPredictionInput = typeof ComposerPredictionInput.Type;

export const ComposerPredictionResult = Schema.Struct({ prediction: Schema.NullOr(Schema.String) });
export type ComposerPredictionResult = typeof ComposerPredictionResult.Type;
