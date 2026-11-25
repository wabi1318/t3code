const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const success = {
  status: 0,
  stdout: JSON.stringify({ message: "Synced", merge_type: "merge", base_branch: "main" }),
};
for (const { name, responses, attempts, result, status } of [
  { name: "successful merge", responses: [success], attempts: 1, result: "synced", status: 0 },
  {
    name: "truncated response recovers",
    responses: [{ status: 1, stderr: "unexpected end of JSON input" }, success],
    attempts: 2,
    result: "synced",
    status: 0,
  },
  {
    name: "server outage recovers",
    responses: [{ status: 1, stderr: "gh: Bad Gateway (HTTP 502)" }, success],
    attempts: 2,
    result: "synced",
    status: 0,
  },
  {
    name: "invalid success response recovers",
    responses: [{ status: 0, stdout: "{" }, success],
    attempts: 2,
    result: "synced",
    status: 0,
  },
  {
    name: "conflict is handed off without retry",
    responses: [{ status: 1, stderr: "gh: Merge conflict (HTTP 409)" }],
    attempts: 1,
    result: "conflict",
    status: 0,
  },
  {
    name: "permission failure stays a failure",
    responses: [{ status: 1, stderr: "gh: Forbidden (HTTP 403)" }, success],
    attempts: 1,
    result: "",
    status: 1,
  },
  {
    name: "persistent transport failure is bounded",
    responses: Array.from({ length: 3 }, () => ({ status: 1, stderr: "unexpected EOF" })),
    attempts: 3,
    result: "",
    status: 1,
  },
]) {
  test(name, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-upstream-test-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
    fs.writeFileSync(
      path.join(dir, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.RUNNER_TEMP;
const countPath = dir + '/count';
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath)) : 0;
fs.writeFileSync(countPath, String(count + 1));
const response = JSON.parse(fs.readFileSync(dir + '/responses.json'))[count];
process.stdout.write(response.stdout || '');
process.stderr.write(response.stderr || '');
process.exit(response.status);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const output = path.join(dir, "output");
    fs.writeFileSync(output, "");
    const run = spawnSync("bash", [path.join(__dirname, "sync-upstream.sh")], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_REPO: "owner/fork",
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
      },
      encoding: "utf8",
    });
    assert.equal(run.status, status, run.stderr);
    assert.equal(Number(fs.readFileSync(path.join(dir, "count"))), attempts);
    assert.equal(fs.readFileSync(output, "utf8").trim(), result ? `result=${result}` : "");
  });
}

test("publication keeps the verified upstream snapshot when the remote advances", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-publish-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".t3/upstream-sync"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".t3/upstream-sync/.git"), "");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const dir = process.env.RUNNER_TEMP;
const args = process.argv.slice(2);
if (args[0] === '-C') args.splice(0, 2);
fs.appendFileSync(dir + '/git-calls', JSON.stringify(args) + '\\n');
if (args[0] === 'rev-parse') process.stdout.write(dir + '/.git');
if (args[0] === 'remote') process.stdout.write('https://github.com/owner/fork.git');
if (args[0] === 'fetch' && args.some(arg => arg.startsWith('https://'))) fs.writeFileSync(dir + '/upstream-moved', '');
if (args[0] === 'merge-base' && fs.existsSync(dir + '/upstream-moved')) process.exit(1);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, "gh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo') process.stdout.write('owner/fork');
if (args[0] === 'pr' && args[1] === 'create') process.stdout.write('https://github.com/owner/fork/pull/1');
`,
    { mode: 0o755 },
  );
  const run = spawnSync(
    "bash",
    [path.join(__dirname, "../../scripts/sync-upstream.sh"), "publish"],
    {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const calls = fs
    .readFileSync(path.join(dir, "git-calls"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(calls.some((args) => args[0] === "fetch" && args.includes("origin")));
  assert.ok(calls.some((args) => args[0] === "push"));
  assert.equal(fs.existsSync(path.join(dir, "upstream-moved")), false);
});
