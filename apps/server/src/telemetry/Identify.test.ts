import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  Layer.provideMerge(
    ServerSecretStore.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
  ).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry identity", (it) => {
  it.effect("keeps the anonymous install id and does not read provider credential files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const anonymousId = "persisted-anonymous-id";
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);
      const installId = yield* sha256(anonymousId);
      const codexAuth = yield* writeHomeFile(
        homeDirectory,
        ".codex/auth.json",
        `{"tokens":{"account_id":"ws-1"}}`,
      );
      const claudeJson = yield* writeHomeFile(
        homeDirectory,
        ".claude.json",
        `{"userID":"claude-machine"}`,
      );
      const reads: Array<string> = [];
      const tracingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath) => {
          reads.push(filePath);
          return fileSystem.readFileString(filePath);
        },
      });

      const identity = yield* Identify.getTelemetryIdentityForHome(homeDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, tracingFileSystem),
      );

      assert.deepEqual(identity, { distinctId: installId, installId });
      assert.notInclude(reads, codexAuth);
      assert.notInclude(reads, claudeJson);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-install-"))),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (filePath, options) =>
          fileSystem.open(filePath, options).pipe(
            Effect.map((file): FileSystem.File =>
              Object.assign(Object.create(file), {
                writeAll: (buffer: Uint8Array) =>
                  file.writeAll(buffer.subarray(0, Math.floor(buffer.length / 2))).pipe(
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "WriteZero",
                          module: "FileSystem",
                          method: "writeAll",
                          pathOrDescriptor: filePath,
                        }),
                      ),
                    ),
                  ),
              }),
            ),
          ),
      });

      const identity = yield* Identify.getTelemetryIdentityForHome(
        path.join(config.baseDir, "home"),
      ).pipe(Effect.provideService(FileSystem.FileSystem, tornWrites));

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentityForHome(
        path.join(config.baseDir, "home"),
      );
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });

  it.effect("reports the Connect account and does not read provider credential files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const privateAccessToken = "private-codex-access-token";
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));
      const codexAuth = yield* writeHomeFile(
        homeDirectory,
        ".codex/auth.json",
        `{"tokens":{"access_token":"${privateAccessToken}","account_id":"ws-1"}}`,
      );
      const claudeJson = yield* writeHomeFile(
        homeDirectory,
        ".claude.json",
        `{"userID":"claude-machine","oauthAccount":{"accountUuid":"claude-person"}}`,
      );
      const reads: Array<string> = [];
      const tracingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath) => {
          reads.push(filePath);
          return fileSystem.readFileString(filePath);
        },
      });

      const owners = yield* Identify.getServerOwnersForHome(homeDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, tracingFileSystem),
      );

      assert.deepEqual(owners, [{ source: "connect", ownerId: yield* sha256("user_connect") }]);
      assert.notInclude(reads, codexAuth);
      assert.notInclude(reads, claudeJson);
      assert.notInclude(JSON.stringify(owners), privateAccessToken);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-"))),
  );
});
