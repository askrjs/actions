// External proposal. Pure policy: no filesystem, process, npm or network calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export const HELPER_COMMIT = '3f26c662d728686e3fe18653d57e361dc987a9a6';
export const HELPER_TREE = '161ee74d0c1ebf0e6e28f502b60e99b01ff8427c';
export const HELPER_SHA = '202e5f8971ced93e63230a7cb57bf0ed364d1312d7094e18c81ad202ccbf2fd7';
export const REGISTRY_SHA = '749235e82913bce0286f059f9465d517824142fe67e536f46dd2b46ce05bc690';
export const METADATA = Object.freeze([
  'RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_REPOSITORY', 'GITHUB_SHA',
  'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_ACTION_PATH',
  'RUNNER_OS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'BOUNDARY_REQUESTED_HEAD',
]);
export const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PUBLIC = 'https://registry.npmjs.org/';
const sensitive = /(?:token|secret|password|credential|private_key)/i;
const reserved = /^(?:npm_config_|node_|git_|github_|runner_|actions_|boundary_|phase$|manifest_ref$|manifest_sha256$|ci$|home$|userprofile$|appdata$|localappdata$|path$|pathext$|systemroot$|comspec$|windir$|tmp$|temp$|tmpdir$|bash_env$|env$|shell$|shellopts$|bashopts$|ld_|dyld_|.*proxy$)/i;
const object = (value, keys, label) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
};
const hash = (value, label) => assert.ok(typeof value === 'string' && HASH.test(value), label);
const text = (value, label) => {
  assert.ok(typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), label);
  return value;
};
export const paths = (platform) => platform === 'win32' ? win32 : posix;
export function relative(value, platform, label) {
  const p = paths(platform);
  text(value, label);
  assert.ok(!p.isAbsolute(value) && value !== '..' && !value.split(/[\\/]/).includes('..'), label);
  assert.equal(p.normalize(value), value, label);
  return value;
}
export function absolute(value, platform, label) {
  const p = paths(platform);
  text(value, label);
  assert.ok(p.isAbsolute(value) && p.normalize(value) === value, label);
  // UNC/device paths are outside this hosted-runner proposal.
  if (platform === 'win32') assert.match(value, /^[A-Z]:\\/);
  return value;
}
export function readConfig(raw) {
  assert.ok(Buffer.isBuffer(raw) && raw.length <= 16384, 'bounded project config');
  const value = raw.toString('utf8');
  assert.ok(Buffer.from(value).equals(raw), 'UTF-8 config');
  const seen = new Set();
  for (const line of value.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || /^[#;]/.test(clean)) continue;
    const match = /^(registry|@askrjs:registry)\s*=\s*(https:\/\/registry\.npmjs\.org\/)\s*$/.exec(clean);
    assert.ok(match && !seen.has(match[1]), 'project config requires separate review; no rewrite/bypass');
    seen.add(match[1]);
  }
  return true;
}
export function decodeRequest(encoded, expected) {
  hash(expected, 'literal request digest');
  assert.ok(typeof encoded === 'string' && encoded.length <= 131072 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'bounded base64 request');
  const raw = Buffer.from(encoded, 'base64');
  assert.equal(raw.toString('base64'), encoded, 'canonical base64');
  assert.ok(raw.length <= 65536, 'request byte cap: fail, never truncate');
  assert.equal(digest(raw), expected, 'request authority differs');
  return validateRequest(JSON.parse(raw.toString('utf8')));
}
export function validateRequest(r) {
  object(r, ['schema', 'mode', 'platform', 'jobPolicySha256', 'authority', 'manifest', 'tools', 'helperConfigs', 'command'], 'request fields');
  assert.equal(r.schema, 1);
  assert.ok(['release','fixture'].includes(r.mode), 'explicit release or source-qualification fixture mode');
  assert.ok(['linux', 'darwin', 'win32'].includes(r.platform));
  hash(r.jobPolicySha256, 'shared job policy identity');
  if (r.mode === 'release') {
    object(r.authority, ['policyReviewSha256', 'applicationAdmissionSha256', 'finalInputSha256', 'callerInventorySha256', 'lifecycleInventorySha256'], 'release authority references');
    for (const [k, v] of Object.entries(r.authority)) hash(v, k);
  } else {
    object(r.authority, ['fixtureSourceSha256','fixturePolicySha256','releaseQualification','finalToolAuthorityApproved'], 'fixture authority cannot be release authority');
    hash(r.authority.fixtureSourceSha256, 'fixture source'); hash(r.authority.fixturePolicySha256, 'fixture policy');
    assert.equal(r.authority.releaseQualification, false); assert.equal(r.authority.finalToolAuthorityApproved, false);
  }
  object(r.manifest, ['ref', 'sha256', 'base64'], 'manifest coordinates');
  assert.match(r.manifest.ref, SHA); hash(r.manifest.sha256, 'manifest digest');
  const manifestRaw = Buffer.from(r.manifest.base64, 'base64');
  assert.equal(manifestRaw.toString('base64'), r.manifest.base64, 'canonical frozen manifest bytes');
  assert.equal(digest(manifestRaw), r.manifest.sha256, 'actual frozen manifest bytes required');
  const manifest = JSON.parse(manifestRaw.toString('utf8'));
  assert.equal(manifest.complete, true); assert.equal(manifest.release, '0.5.0');
  assert.deepEqual(manifest.toolchain, { node: '24.21.0', npm: '12.0.1' });
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length === 18);
  object(r.tools, ['nodeSha256', 'bundledNpmCli', 'npmCliSha256', 'pathDirectories', 'system', 'scriptShell'], 'tool projection');
  hash(r.tools.nodeSha256, 'Node bytes'); hash(r.tools.npmCliSha256, 'npm12 CLI bytes');
  object(r.tools.bundledNpmCli, ['path', 'sha256'], 'bundled npm');
  absolute(r.tools.bundledNpmCli.path, r.platform, 'bundled npm path');
  hash(r.tools.bundledNpmCli.sha256, 'bundled npm bytes');
  assert.ok(Array.isArray(r.tools.pathDirectories) && r.tools.pathDirectories.length > 0);
  assert.equal(new Set(r.tools.pathDirectories).size, r.tools.pathDirectories.length, 'duplicate PATH directory');
  for (const dir of r.tools.pathDirectories) absolute(dir, r.platform, 'explicit system PATH directory');
  object(r.tools.scriptShell, ['path', 'sha256', 'args'], 'reviewed script shell');
  absolute(r.tools.scriptShell.path, r.platform, 'script shell path');
  hash(r.tools.scriptShell.sha256, 'script shell bytes');
  assert.deepEqual(r.tools.scriptShell.args, ['--noprofile', '--norc', '-e', '-o', 'pipefail'], 'only explicitly reviewed Bash steps; no PowerShell/operator conversion');
  object(r.tools.system, r.platform === 'win32' ? ['SystemRoot', 'ComSpec', 'PATHEXT'] : [], 'finite OS metadata');
  if (r.platform === 'win32') {
    absolute(r.tools.system.SystemRoot, r.platform, 'SystemRoot');
    absolute(r.tools.system.ComSpec, r.platform, 'ComSpec');
    assert.match(r.tools.system.PATHEXT, /^\.[A-Z0-9]+(?:;\.[A-Z0-9]+)*$/);
  }
  assert.ok(Array.isArray(r.helperConfigs) && r.helperConfigs.length === 18, 'complete helper source/config authority');
  const repos = ['askr', ...['auth','charts','cli','fetch','i18n','logos','lucide','monaco','node','orm','otel','schema','server','testing','themes','ui','vite'].map(x => 'askr-' + x)].map(x => 'askrjs/' + x);
  assert.deepEqual(r.helperConfigs.map(x => x.repo).sort(), repos.sort(), 'exact unique18 sources');
  const projected = manifest.packages.map(({ repo, commit, tree }) => ({ repo, commit, tree })).sort((a,b) => a.repo.localeCompare(b.repo));
  assert.deepEqual(r.helperConfigs.map(({ repo, commit, tree }) => ({ repo, commit, tree })).sort((a,b) => a.repo.localeCompare(b.repo)), projected, 'config witnesses must describe the actual frozen manifest sources');
  for (const row of r.helperConfigs) {
    object(row, ['repo', 'commit', 'tree', 'npmrcBase64', 'npmrcSha256'], 'source config authority');
    assert.match(row.commit, SHA); assert.match(row.tree, SHA);
    if (row.npmrcBase64 === null) assert.equal(row.npmrcSha256, null, 'absence pair');
    else {
      const raw = Buffer.from(row.npmrcBase64, 'base64');
      assert.equal(raw.toString('base64'), row.npmrcBase64); hash(row.npmrcSha256, 'config digest');
      assert.equal(digest(raw), row.npmrcSha256); readConfig(raw);
    }
  }
  const c = r.command;
  object(c, ['id', 'kind', 'phase', 'registry', 'cwd', 'scriptBase64', 'scriptSha256', 'projectConfigs', 'environment'], 'command fields');
  assert.match(c.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.ok(['bootstrap', 'helper', 'script'].includes(c.kind));
  assert.ok(['public', 'graph'].includes(c.registry));
  relative(c.cwd, r.platform, 'workspace-relative cwd');
  if (c.kind === 'helper') assert.ok(['prepare', 'verify-current', 'cleanup'].includes(c.phase));
  else assert.equal(c.phase, null);
  if (c.kind === 'script') {
    const script = Buffer.from(c.scriptBase64, 'base64');
    assert.equal(script.toString('base64'), c.scriptBase64); hash(c.scriptSha256, 'original script digest');
    assert.equal(digest(script), c.scriptSha256); assert.ok(script.length && !script.includes(0));
  } else { assert.equal(c.scriptBase64, null); assert.equal(c.scriptSha256, null); }
  if (c.kind === 'bootstrap') { assert.equal(c.registry, 'public'); assert.equal(c.cwd, '.'); }
  if (c.kind === 'helper') assert.equal(c.registry, c.phase === 'verify-current' ? 'graph' : 'public');
  assert.ok(Array.isArray(c.projectConfigs));
  const configNames = new Set();
  for (const row of c.projectConfigs) {
    object(row, ['path', 'base64', 'sha256'], 'effective project config witness');
    relative(row.path, r.platform, 'project config path');
    assert.equal(paths(r.platform).basename(row.path), '.npmrc');
    assert.ok(!configNames.has(row.path)); configNames.add(row.path);
    if (row.base64 === null) assert.equal(row.sha256, null);
    else { const raw = Buffer.from(row.base64, 'base64'); assert.equal(raw.toString('base64'), row.base64); hash(row.sha256, 'project config digest'); assert.equal(digest(raw), row.sha256); readConfig(raw); }
  }
  {
    const p = paths(r.platform);
    const parts = c.cwd === '.' ? [] : c.cwd.split(p.sep);
    const required = ['.npmrc', ...parts.map((_, i) => p.join(...parts.slice(0, i + 1), '.npmrc'))];
    for (const file of required) assert.ok(configNames.has(file), 'each cwd ancestor config must be explicit, including absence');
  }
  assert.ok(c.environment && typeof c.environment === 'object' && !Array.isArray(c.environment));
  for (const [k, v] of Object.entries(c.environment)) {
    assert.match(k, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(!reserved.test(k) && !sensitive.test(k), 'unreviewed injection/credential field');
    text(v, 'literal reviewed owner value');
    assert.ok(!v.includes('${') && !v.includes('$('), 'no ambient expansion');
  }
  return r;
}
export function selectMetadata(ambient, platform, mode = 'release') {
  const selected = Object.create(null);
  for (const key of METADATA) selected[key] = text(ambient[key], key);
  const actionPaths = paths(platform);
  assert.ok(actionPaths.isAbsolute(selected.GITHUB_ACTION_PATH), 'GITHUB_ACTION_PATH');
  if (platform === 'win32') assert.match(selected.GITHUB_ACTION_PATH, /^[A-Z]:\\/);
  else assert.ok(!selected.GITHUB_ACTION_PATH.startsWith('//'), 'GITHUB_ACTION_PATH');
  selected.GITHUB_ACTION_PATH = actionPaths.resolve(selected.GITHUB_ACTION_PATH);
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_ACTION_PATH']) absolute(selected[key], platform, key);
  const supported = ['askr', ...['auth','charts','cli','fetch','i18n','logos','lucide','monaco','node','orm','otel','schema','server','testing','themes','ui','vite'].map(x => 'askr-' + x), 'askr-examples', 'website', 'destroyer', 'js-framework-benchmark'];
  assert.ok(mode === 'fixture' ? selected.GITHUB_REPOSITORY === 'askrjs/actions' : mode === 'release' && supported.includes(selected.GITHUB_REPOSITORY.replace(/^askrjs\//, '')) && selected.GITHUB_REPOSITORY.startsWith('askrjs/'), 'fixture host is Actions only; release retains exact22');
  assert.match(selected.GITHUB_SHA, SHA);
  assert.equal(selected.RUNNER_OS, { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[platform], 'actual runner OS');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(selected[key], /^[1-9][0-9]{0,19}$/, key);
  assert.match(selected.BOUNDARY_REQUESTED_HEAD, SHA, 'actual event requested head');
  return selected;
}
export function registryChoice(mode, server) {
  object(mode, ['mode', 'registry'], 'owned graph mode');
  if (mode.mode === 'public') { assert.equal(mode.registry, PUBLIC); assert.equal(server, null); return PUBLIC; }
  assert.equal(mode.mode, 'candidate');
  object(server, ['id', 'pid', 'registry', 'readOnly'], 'owned registry coordinates');
  assert.match(server.id, /^[a-f0-9-]{36}$/); assert.ok(Number.isSafeInteger(server.pid) && server.pid > 1); assert.equal(server.readOnly, true);
  assert.match(server.registry, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/);
  const u = new URL(server.registry); assert.ok(+u.port <= 65535 && +u.port > 0);
  assert.equal(mode.registry, server.registry); return server.registry;
}
export function childEnvironment(r, metadata, nodePath, registry) {
  validateRequest(r);
  object(metadata, METADATA, 'finite runner metadata');
  selectMetadata(metadata, r.platform, r.mode);
  const p = paths(r.platform);
  absolute(nodePath, r.platform, 'actual verified Node path');
  const root = p.join(metadata.RUNNER_TEMP, 'askr-0.5-private-' + r.jobPolicySha256);
  assert.ok(registry === PUBLIC || /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(registry));
  const env = {
    ...metadata, ...r.tools.system, ...r.command.environment,
    CI: 'true', GITHUB_ACTIONS: 'true',
    HOME: p.join(root, 'home'), TMPDIR: p.join(root, 'tmp'), TMP: p.join(root, 'tmp'), TEMP: p.join(root, 'tmp'),
    PATH: [p.join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain', 'node_modules', '.bin'), p.dirname(nodePath), ...r.tools.pathDirectories].join(r.platform === 'win32' ? ';' : ':'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: p.join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.eol', GIT_CONFIG_VALUE_1: 'lf',
    npm_config_userconfig: p.join(root, 'user.npmrc'), npm_config_globalconfig: p.join(root, 'global.npmrc'),
    npm_config_cache: p.join(root, 'npm-cache'), npm_config_proxy: 'null', npm_config_https_proxy: 'null',
    NPM_CONFIG_REGISTRY: registry, 'npm_config_@askrjs:registry': registry,
    NPM_CONFIG_AUDIT: registry === PUBLIC ? 'true' : 'false',
  };
  if (r.platform === 'win32') Object.assign(env, { USERPROFILE: env.HOME, APPDATA: p.join(root, 'appdata'), LOCALAPPDATA: p.join(root, 'localappdata') });
  if (r.command.kind === 'helper') Object.assign(env, { PHASE: r.command.phase, MANIFEST_REF: r.manifest.ref, MANIFEST_SHA256: r.manifest.sha256 });
  assert.equal(new Set(Object.keys(env).map(k => k.toLowerCase())).size, Object.keys(env).length, 'case-colliding environment');
  return { root, env };
}
export function invocation(r, metadata, nodePath, actionPath, root) {
  const p = paths(r.platform), c = r.command;
  if (c.kind === 'bootstrap') return { executable: nodePath, args: [r.tools.bundledNpmCli.path, 'install', '--prefix', p.join(metadata.RUNNER_TEMP, 'askr-candidate-toolchain'), '--ignore-scripts', '--no-audit', '--no-fund', 'npm@12.0.1'], cwd: p.join(metadata.GITHUB_WORKSPACE, c.cwd) };
  if (c.kind === 'helper') return { executable: nodePath, args: [p.join(actionPath, 'h19', 'qualify.mjs')], cwd: p.join(metadata.GITHUB_WORKSPACE, c.cwd) };
  return { executable: r.tools.scriptShell.path, args: [...r.tools.scriptShell.args, p.join(root, 'scripts', c.id + '.bash')], cwd: p.join(metadata.GITHUB_WORKSPACE, c.cwd) };
}
