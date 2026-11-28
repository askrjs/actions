import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "askr-ci-gate-"));
const gate = fileURLToPath(new URL("../actions/require-main-ci/require-main-ci.sh", import.meta.url));
const repository = "askrjs/askr";
const sha = "a".repeat(40);
const goodRun = {
  head_sha: sha,
  head_branch: "main",
  head_repository: { full_name: repository },
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/askrjs/askr/actions/runs/1",
};

const cli = join(root, "gh");
writeFileSync(cli, `#!/usr/bin/env node
const expected = ["api", "--method", "GET", "repos/${repository}/actions/workflows/ci.yml/runs",
  "-f", "branch=main", "-f", "event=push", "-f", "head_sha=${sha}", "-F", "per_page=1"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(20);
if (process.env.GH_FIXTURE_FAIL) process.exit(21);
process.stdout.write(process.env.GH_FIXTURE_RESPONSE);
`);
chmodSync(cli, 0o755);
test.after(() => rmSync(root, { recursive: true, force: true }));

function check(runs, overrides = {}) {
  const result = spawnSync("bash", [gate], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sha,
      GH_FIXTURE_RESPONSE: JSON.stringify({ workflow_runs: runs }),
      ...overrides,
    },
  });
  assert.ifError(result.error);
  return result;
}

test("accepts only successful push CI for the exact repository, ref, and commit", () => {
  const result = check([goodRun]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verified main CI: https:/);
});

test("rejects missing or mismatched runs, and a failed or pending latest rerun", () => {
  for (const runs of [
    [],
    [{ ...goodRun, head_sha: "b".repeat(40) }],
    [{ ...goodRun, head_branch: "develop" }],
    [{ ...goodRun, head_repository: { full_name: "another/askr" } }],
    [{ ...goodRun, event: "pull_request" }],
    [{ ...goodRun, conclusion: "failure" }, goodRun],
    [{ ...goodRun, status: "in_progress", conclusion: null }, goodRun],
  ]) {
    const result = check(runs);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /must complete successfully/);
  }
});

test("rejects other branches and fails closed when GitHub cannot answer", () => {
  const branch = check([goodRun], { GITHUB_REF: "refs/heads/develop" });
  assert.equal(branch.status, 1);
  assert.match(branch.stdout, /Release requires refs\/heads\/main/);
  assert.equal(check([goodRun], { GH_FIXTURE_FAIL: "1" }).status, 21);
});
