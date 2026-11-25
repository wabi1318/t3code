import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayLayer } from "./relayTracing.ts";

const tracesTo = (policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ).pipe(
        Layer.provide(ManagedPolicy.layerTest(policy)),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.map(Option.isSome),
  );

it.effect("a policy with telemetry off stops relay tracing to T3 Connect", () =>
  Effect.gen(function* () {
    assert.isTrue(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect.each(["true", "false", undefined])(
  "uses the discovered shell consent instead of the cached preference %s",
  (cachedPreference) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        T3CODE_TELEMETRY_ENABLED: cachedPreference,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "test-relay",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "test-token",
      };
      const requests: Array<string> = [];
      const httpClient = HttpClient.make((request) => {
        if (request.body._tag === "Uint8Array") {
          requests.push(new TextDecoder().decode(request.body.body));
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
      });
      const record = (name: string) =>
        Effect.void.pipe(Effect.withSpan(name), RelayTracing.withRelayClientTracing);
      yield* Effect.gen(function* () {
        yield* record("test.pending");
        delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
        delete env.T3CODE_TELEMETRY_ENABLED;
        yield* record("test.unset");
        env.T3CODE_TELEMETRY_ENABLED = "false";
        yield* record("test.denied");
        env.T3CODE_TELEMETRY_ENABLED = "true";
        yield* record("test.allowed");
        env.T3CODE_OTEL_SDK_DISABLED = "true";
        yield* record("test.sdk-disabled");
      }).pipe(
        Effect.provide(
          relayLayer({ serviceName: "t3code-server", runtime: "node", client: "desktop" }).pipe(
            Layer.provide(ManagedPolicy.layerTest()),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-consent-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
            Layer.provide(Layer.succeed(HostProcess.Environment, env)),
          ),
        ),
      );
      const sent = requests.join("\n");
      assert.include(sent, "test.allowed");
      for (const name of ["test.pending", "test.unset", "test.denied", "test.sdk-disabled"]) {
        assert.notInclude(sent, name);
      }
    }),
);
