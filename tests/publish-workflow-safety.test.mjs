import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/publish-package.yml", import.meta.url);

test("the publish workflow does not execute caller-selected commands", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.doesNotMatch(workflow, /^\s+release-command:/m);
  assert.doesNotMatch(workflow, /run:\s*\$\{\{\s*inputs\./);
  assert.match(workflow, /name: Run complete release gate\n\s+run: npm run check/);
});

test("write and OIDC permissions are isolated to the post-verification job", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const verifyStart = workflow.indexOf("\n  verify:");
  const publishStart = workflow.indexOf("\n  publish:");
  assert.ok(verifyStart > 0 && publishStart > verifyStart);

  const verifyJob = workflow.slice(verifyStart, publishStart);
  const publishJob = workflow.slice(publishStart);
  assert.doesNotMatch(verifyJob, /contents:\s*write/);
  assert.doesNotMatch(verifyJob, /id-token:\s*write/);
  assert.match(publishJob, /needs: verify/);
  assert.match(publishJob, /contents:\s*write/);
  assert.match(publishJob, /id-token:\s*write/);
});

test("browser release gates install every supported Playwright engine", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const installs = workflow.match(
    /npx playwright install --with-deps chromium firefox webkit/g,
  );
  assert.equal(installs?.length, 2);
});
