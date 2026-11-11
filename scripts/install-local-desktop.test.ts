// @effect-diagnostics nodeBuiltinImport:off - Exercises the shell installer in a temporary app directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "vite-plus/test";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it.each([
  { name: "native Trash", nativeTrash: true, symlink: false },
  { name: "macOS without the trash command", nativeTrash: false, symlink: false },
  { name: "a relative app symlink", nativeTrash: true, symlink: true },
])("registers the replacement before removing the previous app: $name", async (fixture) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-local-install-test-"));
  try {
    const applications = NodePath.join(root, "Applications");
    const destination = NodePath.join(applications, "T3 Code (Beta).app");
    const backup = NodePath.join(root, "backups");
    const bin = NodePath.join(root, "bin");
    const trashed = NodePath.join(root, "previous.app");
    const events = NodePath.join(root, "events");
    const hostArchitecture = HostProcess.Architecture.defaultValue();
    const architecture = hostArchitecture === "arm64" ? "mac-arm64" : "mac";
    const sourceApp = NodePath.join(
      root,
      "release/local-desktop",
      architecture,
      "T3 Code (Beta).app",
    );
    await NodeFSP.mkdir(NodePath.join(sourceApp, "Contents"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(sourceApp, "Contents/Info.plist"), "new");
    await NodeFSP.mkdir(applications);
    await NodeFSP.mkdir(bin);
    await NodeFSP.mkdir(NodePath.join(root, "scripts"));
    await NodeFSP.mkdir(NodePath.join(root, "apps/desktop"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "apps/desktop/package.json"),
      '{"version":"0.1.7"}',
    );
    if (fixture.symlink) {
      await NodeFSP.mkdir(NodePath.join(applications, "Original.app"));
      await NodeFSP.symlink("Original.app", destination);
    } else {
      await NodeFSP.mkdir(destination);
    }
    const writeStub = (name: string, body: string) =>
      NodeFSP.writeFile(NodePath.join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    await writeStub("vp", "exit 0");
    await writeStub(
      "uname",
      `if [[ "\${1:-}" == -m ]]; then echo ${hostArchitecture === "arm64" ? "arm64" : "x86_64"}; else echo Darwin; fi`,
    );
    await writeStub("ditto", 'cp -R "$1" "$2"');
    await writeStub("register", `echo registered >> ${quote(events)}`);
    const moveToTrash = `echo trashed >> ${quote(events)}\nfor target in "$@"; do :; done\nmv "$target" ${quote(trashed)}`;
    if (fixture.nativeTrash) await writeStub("trash", moveToTrash);
    await writeStub("osascript", moveToTrash);
    const original = await NodeFSP.readFile(
      new URL("./install-local-desktop.sh", import.meta.url),
      "utf8",
    );
    const source = original
      .replace(
        "destination='/Applications/T3 Code (Beta).app'",
        `destination=${quote(destination)}`,
      )
      .replace(
        'backup_root="$HOME/Library/Application Support/T3-local-build-backups"',
        `backup_root=${quote(backup)}`,
      )
      .replace(
        "'/Applications/.t3-local-install.XXXXXX'",
        quote(NodePath.join(applications, ".t3-local-install.XXXXXX")),
      )
      .replaceAll(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        NodePath.join(bin, "register"),
      )
      .replaceAll("/usr/bin/trash", NodePath.join(bin, "trash"))
      .replaceAll("/usr/bin/osascript", NodePath.join(bin, "osascript"));
    expect(source).toContain(`destination=${quote(destination)}`);
    expect(source).toContain(`backup_root=${quote(backup)}`);
    expect(source).toContain(quote(NodePath.join(applications, ".t3-local-install.XXXXXX")));
    const installer = NodePath.join(root, "scripts/install-local-desktop.sh");
    await NodeFSP.writeFile(installer, source);
    const result = NodeChildProcess.spawnSync("bash", [installer], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(await NodeFSP.readFile(events, "utf8")).toBe("registered\ntrashed\n");
    expect(await NodeFSP.readFile(NodePath.join(destination, "Contents/Info.plist"), "utf8")).toBe(
      "new",
    );
    expect(await NodeFSP.readdir(backup)).toEqual([]);
    expect((await NodeFSP.lstat(trashed)).isSymbolicLink()).toBe(fixture.symlink);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
