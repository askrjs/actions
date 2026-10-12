import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { childEnvironment, digest, selectMetadata, validateRequest } from "../actions/private-caller-boundary/policy.mjs";

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

test("should ensure caller inputs never become executable action source", async () => {
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


function metadata(platform) {
  const root = platform === "win32" ? "C:\\runner" : "/runner";
  const separator = platform === "win32" ? "\\" : "/";
  const path = (name) => root + separator + name;
  return {
    RUNNER_TEMP: path("temp"), GITHUB_WORKSPACE: path("workspace"),
    GITHUB_REPOSITORY: "askrjs/askr-auth", GITHUB_SHA: "a".repeat(40),
    GITHUB_ENV: path("github-env"), GITHUB_PATH: path("github-path"),
    GITHUB_ACTION_PATH: path("action"),
    RUNNER_OS: { linux: "Linux", darwin: "macOS", win32: "Windows" }[platform],
    GITHUB_RUN_ID: "38167994522", GITHUB_RUN_ATTEMPT: "2",
    BOUNDARY_REQUESTED_HEAD: "b".repeat(40),
  };
}

function request(platform) {
  const repos = ["askr", ...["auth", "charts", "cli", "fetch", "i18n", "logos", "lucide", "monaco", "node", "orm", "otel", "schema", "server", "testing", "themes", "ui", "vite"].map((name) => "askr-" + name)];
  const packages = repos.map((repo) => ({ repo: "askrjs/" + repo, commit: "c".repeat(40), tree: "d".repeat(40) }));
  const raw = Buffer.from(JSON.stringify({ complete: true, release: "0.5.0", toolchain: { node: "24.21.0", npm: "12.0.1" }, packages }));
  const prefix = platform === "win32" ? "C:\\runner\\" : "/runner/";
  return {
    schema: 1, mode: "release", platform, jobPolicySha256: "1".repeat(64),
    authority: Object.fromEntries(["policyReviewSha256", "applicationAdmissionSha256", "finalInputSha256", "callerInventorySha256", "lifecycleInventorySha256"].map((key) => [key, "2".repeat(64)])),
    manifest: { ref: "c".repeat(40), sha256: digest(raw), base64: raw.toString("base64") },
    tools: {
      nodeSha256: "3".repeat(64), npmCliSha256: "4".repeat(64),
      bundledNpmCli: { path: prefix + "npm-cli.js", sha256: "5".repeat(64) },
      pathDirectories: [prefix + "bin"],
      system: platform === "win32" ? { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD" } : {},
      scriptShell: { path: prefix + "bash", sha256: "6".repeat(64), args: ["--noprofile", "--norc", "-e", "-o", "pipefail"] },
    },
    helperConfigs: packages.map((row) => ({ ...row, npmrcBase64: null, npmrcSha256: null })),
    command: { id: "metadata-test", kind: "script", phase: null, registry: "public", cwd: ".", scriptBase64: "dHJ1ZQ==", scriptSha256: digest(Buffer.from("true")), projectConfigs: [{ path: ".npmrc", base64: null, sha256: null }], environment: {} },
  };
}

test("should preserve validated event metadata in the private child", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const ambient = { ...metadata(platform), TOKEN: "not inherited", NODE_OPTIONS: "not inherited" };
    const selected = selectMetadata(ambient, platform);
    const { env } = childEnvironment(request(platform), selected, platform === "win32" ? "C:\\runner\\node.exe" : "/runner/node", "https://registry.npmjs.org/");
    for (const key of ["RUNNER_OS", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "BOUNDARY_REQUESTED_HEAD", "GITHUB_SHA"]) assert.equal(env[key], ambient[key]);
    assert.notEqual(env.BOUNDARY_REQUESTED_HEAD, env.GITHUB_SHA);
    assert.equal(env.TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  }
});

test("should reject malformed or missing event metadata", () => {
  for (const [key, values] of Object.entries({
    RUNNER_OS: ["macOS", "linux", "Linux\n"],
    GITHUB_RUN_ID: ["0", "01", "-1", "1.2", "1".repeat(21)],
    GITHUB_RUN_ATTEMPT: ["0", "1;true", "1\n"],
    BOUNDARY_REQUESTED_HEAD: ["b".repeat(39), "B".repeat(40), "b".repeat(41)],
  })) {
    for (const value of values) assert.throws(() => selectMetadata({ ...metadata("linux"), [key]: value }, "linux"));
    const absent = metadata("linux"); delete absent[key];
    assert.throws(() => selectMetadata(absent, "linux"));
  }
});

test("should reject command overrides of event metadata", () => {
  for (const key of ["RUNNER_OS", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "BOUNDARY_REQUESTED_HEAD"]) {
    const value = request("linux"); value.command.environment[key] = metadata("linux")[key];
    assert.throws(() => validateRequest(value), /unreviewed injection\/credential field/);
  }
});
