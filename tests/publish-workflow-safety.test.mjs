import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/publish-package.yml", import.meta.url);

test("should ensure the publish workflow does not execute caller-selected commands", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.doesNotMatch(workflow, /^\s+release-command:/m);
  assert.doesNotMatch(workflow, /run:\s*\$\{\{\s*inputs\./);
  assert.match(workflow, /name: Run complete release gate\n\s+run: npm run check/);
  assert.match(
    workflow,
    /name: Publish to npm\n\s+run: npm publish --provenance --access public/,
  );
  assert.doesNotMatch(workflow, /actions\/publish-package/);
});

test("should ensure write and OIDC permissions are isolated to the post-verification job", async () => {
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

test("should ensure browser release gates install every supported Playwright engine", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const verifyStart = workflow.indexOf("\n  verify:");
  const publishStart = workflow.indexOf("\n  publish:");
  const verifyJob = workflow.slice(verifyStart, publishStart);
  const publishJob = workflow.slice(publishStart);
  const installCommand =
    /npx playwright install --with-deps chromium firefox webkit/;
  assert.match(verifyJob, installCommand);
  assert.match(publishJob, installCommand);
});
