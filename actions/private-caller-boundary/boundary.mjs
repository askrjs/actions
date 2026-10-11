// Proposed successor entrypoint. Importing this file does not execute a phase.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeRequest, digest, selectMetadata, childEnvironment, invocation, registryChoice, HELPER_SHA, REGISTRY_SHA } from './policy.mjs';

const actionPath = dirname(fileURLToPath(import.meta.url));
const MAX = 1024 * 1024;
async function regular(file, expected = null, owned = false) {
  const st = await lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= MAX, 'bounded regular nonlink file');
  if (owned && process.getuid) assert.equal(st.uid, process.getuid(), 'owned file');
  const raw = await readFile(file);
  assert.equal(raw.length, st.size, 'file changed during read');
  if (expected !== null) assert.equal(digest(raw), expected, 'file identity changed');
  return raw;
}
async function binary(file, expected) {
  const st = await lstat(file);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'regular physical tool file');
  // Tool files are already bounded by their admitted full runtime projection.
  assert.ok(st.size <= 256 * 1024 * 1024, 'tool file cap');
  assert.equal(digest(await readFile(file)), expected, 'actual tool bytes');
}
async function directory(dir, owned = true) {
  const st = await lstat(dir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'owned regular directory');
  assert.equal(await realpath(dir), resolve(dir), 'canonical physical path required');
  if (process.getuid && owned) {
    assert.equal(st.uid, process.getuid(), 'job ownership');
    assert.equal(st.mode & 0o022, 0, 'no group/other directory writes');
  }
}
async function privateDirectory(dir) {
  try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  await directory(dir);
  if (process.getuid) assert.equal((await lstat(dir)).mode & 0o777, 0o700, 'private directory mode');
}
async function fixedFile(file, expected) {
  try { await writeFile(file, expected, { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  assert.deepEqual(await regular(file, null, true), Buffer.from(expected), 'private file was modified; do not silently restore');
  if (process.getuid) assert.equal((await lstat(file)).mode & 0o777, 0o600, 'private file mode');
}
async function configs(r, workspace) {
  for (const row of r.command.projectConfigs) {
    const file = join(workspace, row.path);
    if (row.base64 === null) {
      try { await lstat(file); assert.fail('unexpected project config'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else {
      await directory(dirname(file));
      assert.deepEqual(await regular(file, row.sha256, true), Buffer.from(row.base64, 'base64'));
    }
  }
}
async function graphRegistry(r, metadata, helper) {
  const root = join(metadata.RUNNER_TEMP, 'askr-0.5-candidate-' + r.manifest.sha256);
  await directory(root);
  await regular(join(root, 'manifest.json'), r.manifest.sha256, true);
  const mode = JSON.parse(await regular(join(root, 'mode.json'), null, true));
  const server = mode.mode === 'candidate' ? JSON.parse(await regular(join(root, 'server.json'), null, true)) : null;
  const registry = registryChoice(mode, server);
  if (server) {
    const health = await helper.registryHealth(registry + '__askr-health', 2000);
    assert.deepEqual(health, { id: server.id }, 'owned registry identity required');
  }
  return registry;
}
export async function main() {
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.execArgv.length, 0, 'no wrapper startup options');
  const r = decodeRequest(process.env.BOUNDARY_REQUEST_BASE64, process.env.BOUNDARY_REQUEST_SHA256);
  assert.equal(process.platform, r.platform);
  // These are the only ambient fields selected. No process.env spread occurs.
  const metadata = selectMetadata(process.env, r.platform, r.mode);
  assert.equal(await realpath(actionPath), metadata.GITHUB_ACTION_PATH, 'actual pinned action directory');
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  for (const key of ['NODE_OPTIONS','NODE_PATH','BASH_ENV','ENV']) assert.ok(!process.env[key], 'entrypoint startup boundary');
  await binary(process.execPath, r.tools.nodeSha256);
  await regular(join(actionPath, 'h19', 'qualify.mjs'), HELPER_SHA);
  await regular(join(actionPath, 'h19', 'registry.mjs'), REGISTRY_SHA);
  const helper = await import('./h19/qualify.mjs');
  helper.validateManifest(JSON.parse(Buffer.from(r.manifest.base64, 'base64').toString('utf8')));
  await directory(metadata.RUNNER_TEMP);
  await directory(metadata.GITHUB_WORKSPACE);
  for (const file of ['GITHUB_ENV', 'GITHUB_PATH']) {
    await directory(dirname(metadata[file]));
    try { await regular(metadata[file], null, true); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const dir of r.tools.pathDirectories) await directory(dir, false);
  if (r.command.kind === 'bootstrap') await binary(r.tools.bundledNpmCli.path, r.tools.bundledNpmCli.sha256);
  else if (!(r.command.kind === 'helper' && r.command.phase === 'cleanup')) {
    for (const part of ['askr-candidate-toolchain', 'askr-candidate-toolchain/node_modules', 'askr-candidate-toolchain/node_modules/npm']) await directory(join(metadata.RUNNER_TEMP, part));
    await regular(join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js'), r.tools.npmCliSha256, true);
  }
  if (r.command.kind === 'script') await binary(r.tools.scriptShell.path, r.tools.scriptShell.sha256);
  const registry = r.command.registry === 'public' ? 'https://registry.npmjs.org/' : await graphRegistry(r, metadata, helper);
  const { root, env } = childEnvironment(r, metadata, process.execPath, registry);
  await privateDirectory(root);
  const marker = JSON.stringify({ mode: r.mode, jobPolicySha256: r.jobPolicySha256, repository: metadata.GITHUB_REPOSITORY, head: metadata.GITHUB_SHA, toolsSha256: digest(JSON.stringify(r.tools)), authority: r.authority }) + '\n';
  await fixedFile(join(root, 'owner.json'), marker);
  for (const name of ['home','tmp','npm-cache','bootstrap','scripts','receipts','appdata','localappdata']) await privateDirectory(join(root, name));
  for (const file of ['user.npmrc','global.npmrc','gitconfig']) await fixedFile(join(root, file), '');
  await configs(r, metadata.GITHUB_WORKSPACE);
  if (r.command.kind === 'script') await fixedFile(join(root, 'scripts', r.command.id + '.bash'), Buffer.from(r.command.scriptBase64, 'base64'));
  const call = invocation(r, metadata, process.execPath, actionPath, root);
  await directory(call.cwd);
  if (r.command.kind === 'bootstrap') {
    try { await lstat(join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain')); assert.fail('tool prefix must be absent before the one original bootstrap'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const receipt = join(root, 'receipts', r.command.id + '.json');
  // Immutable pre-command receipt. A retry needs a distinct reviewed command id.
  await writeFile(receipt, JSON.stringify({ schema: 1, mode: r.mode, requestSha256: process.env.BOUNDARY_REQUEST_SHA256, command: call, env, finalToolAuthorityAccepted: false, lifecycleAccepted: false, advisoryDispositionAccepted: false, publication: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const result = spawnSync(call.executable, call.args, { cwd: call.cwd, env, shell: false, windowsHide: true, stdio: 'inherit' });
  // Existing job timeout owns termination; no retries/new lifecycle flags added.
  await writeFile(join(root, 'receipts', r.command.id + '-exit.json'), JSON.stringify({ status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, code: result.error.code } : null, processExitOnly: true, releaseQualification: false }) + '\n', { flag: 'wx', mode: 0o600 });
  await fixedFile(join(root, 'user.npmrc'), ''); await fixedFile(join(root, 'global.npmrc'), '');
  await configs(r, metadata.GITHUB_WORKSPACE);
  if (result.error || result.signal || result.status !== 0) throw new Error('reviewed command failed; preserve original raw runner log and exit receipt');
  if (r.command.kind === 'bootstrap') {
    await regular(join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js'), r.tools.npmCliSha256, true);
    await appendFile(metadata.GITHUB_PATH, join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain/node_modules/.bin') + '\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
