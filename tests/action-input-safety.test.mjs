import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const actionsRoot = new URL("../actions/", import.meta.url);

async function actionManifests() {
  const entries = await readdir(actionsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => new URL(`./${entry.name}/action.yml`, actionsRoot));
}

function executableRunBlocks(yaml) {
  const lines = yaml.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.length - line.trimStart().length <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("caller inputs never become executable action source", async () => {
  const violations = [];
  for (const manifest of await actionManifests()) {
    const yaml = await readFile(manifest, "utf8");
    for (const block of executableRunBlocks(yaml)) {
      if (/\$\{\{\s*inputs\./.test(block)) {
        violations.push(join(manifest.pathname, " run block interpolates an input"));
      }
    }
  }
  assert.deepEqual(violations, []);
});
