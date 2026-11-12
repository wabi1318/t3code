#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { composerPredictionCases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
  },
});
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!model || !outputDirectory || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --model <configured-model> --out <directory> [--samples <positive integer>].",
  );
}
const cases = values.case
  ? composerPredictionCases.filter((entry) => values.case!.includes(entry.id))
  : composerPredictionCases;
if (cases.length === 0) throw new Error("No matching cases.");
const decodeBaseline = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sample: Schema.Number,
        prediction: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CodexSettings);

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prediction-eval-" });
    const generation = yield* CodexTextGeneration.makeCodexTextGeneration(
      yield* decodeSettings({}),
    );
    const generate = generation.generateComposerPrediction;
    if (!generate) throw new Error("Composer predictions are unavailable.");
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeBaseline))
      : [];
    const results = [];
    const review = [];
    const answerKey = [];
    for (const fixture of cases) {
      for (let sample = 0; sample < samples; sample += 1) {
        const previous = baseline.find(
          (entry) => entry.id === fixture.id && entry.sample === sample,
        );
        if (values.baseline && !previous)
          throw new Error(`Missing baseline: ${fixture.id}/${sample}.`);
        const [elapsed, generated] = yield* generate({
          cwd,
          context: fixture.context,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model,
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        }).pipe(Effect.timed);
        results.push({
          id: fixture.id,
          sample,
          model,
          ...generated,
          latencyMs: Duration.toMillis(elapsed),
        });
        const newFirst = NodeCrypto.randomInt(2) === 0;
        review.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          context: fixture.context,
          rubric: fixture.rubric,
          ...(previous
            ? {
                A: newFirst ? generated.prediction : previous.prediction,
                B: newFirst ? previous.prediction : generated.prediction,
              }
            : { prediction: generated.prediction }),
          passed: "",
          reason: "",
        });
        answerKey.push({ id: fixture.id, sample, candidate: newFirst ? "A" : "B" });
        yield* fs.makeDirectory(outputDirectory, { recursive: true });
        for (const [name, report] of [
          ["results", results],
          ["review", review],
          ["answer-key", answerKey],
        ] as const) {
          yield* fs.writeFileString(
            path.join(outputDirectory, `${name}.json`),
            yield* encodeReport(report),
          );
        }
        yield* Effect.log(`Completed ${fixture.id}, sample ${sample + 1}/${samples}.`);
      }
    }
    yield* fs.writeFileString(
      path.join(outputDirectory, "summary.json"),
      yield* encodeReport({
        model,
        cases: cases.length,
        samples,
        modelCalls: results.length,
        billing:
          "Uses the configured Codex login; exact monetary cost is not exposed by this generator.",
        grading:
          "Mark each review.json row passed or failed. A case fails when at least half its samples fail.",
      }),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-prediction-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
