// One release's actual tool observation. No final-admission flags are issued here.
// Execute only inside the already reviewed H20 graph-script boundary, from exact CLI P.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELPER = { commit: '1cd66a96243af3a678c1e63d4e0e8df19751feac', tree: 'a843e61bad5fe0583959852adaf0d22f197ee3e8' };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const hex = value => assert.match(value, /^[a-f0-9]{64}$/u);
export const safe = value => {
  assert.equal(typeof value, 'string');
  assert(value && !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value));
  assert(value.split('/').every(part => part && part !== '.' && part !== '..'));
  return value;
};
async function physical(file) {
  assert(path.isAbsolute(file));
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 * 1024 * 1024);
  assert.equal(await fs.realpath(file), path.resolve(file));
  return stat;
}
async function observed(file) {
  const stat = await physical(file), raw = await fs.readFile(file);
  assert.equal(raw.length, stat.size);
  return { file, mode: stat.mode & 0o111 ? 0o755 : 0o644, size: raw.length, sha256: sha(raw) };
}
async function pinned(file, expected) {
  hex(expected);
  const row = await observed(file);
  assert.equal(row.sha256, expected, `Pinned file changed: ${file}`);
  return fs.readFile(file);
}
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const missing = async file => { try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
async function fresh(dir) {
  assert(path.isAbsolute(dir) && await missing(dir), 'fresh owned directory required');
  assert.equal(await fs.realpath(path.dirname(dir)), path.dirname(dir));
  await fs.mkdir(dir, { mode: 0o700 });
}
async function bounded(promise, label, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

// Same Linux PID/start-identity model as tests/helpers/owned-browser.ts. This
// collection observes rootExecutable before admission; it does not self-admit it.
async function snapshot() {
  const rows = [];
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/u.test(pid)) continue;
    try {
      if ((await fs.stat(`/proc/${pid}`)).uid !== process.getuid()) continue;
      const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      let executable = '';
      try { executable = await fs.readlink(`/proc/${pid}/exe`); }
      catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
      rows.push({ pid: Number(pid), parent: Number(fields[1]), startTime: fields[19], state: fields[0], executable });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return rows;
}
export const identity = row => `${row.pid}:${row.startTime}`;
export function descendants(rows, root) {
  if (!rows.some(row => identity(row) === identity(root))) return [];
  const owned = new Set([root.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  return rows.filter(row => owned.has(row.pid));
}
// macOS can provide system dylibs from its loader shared cache, without a
// regular file at the exact absolute name printed by otool. Never invent bytes.
export function osLoaderDependency(platform, name, errorCode) {
  return platform === 'darwin' && errorCode === 'ENOENT' &&
    typeof name === 'string' && path.posix.normalize(name) === name &&
    (name.startsWith('/usr/lib/') || name.startsWith('/System/Library/'));
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 5, 'manifest file/SHA, P inventory file/SHA, fresh output');
  const [manifestFile, manifestSha, inventoryFile, inventorySha, outputArg] = argv;
  assert.equal(process.version, 'v24.21.0');
  assert.equal(process.execArgv.length, 0);
  assert(['linux', 'darwin', 'win32'].includes(process.platform));
  const source = await fs.realpath(process.cwd()), runner = await fs.realpath(process.env.RUNNER_TEMP);
  assert.equal(source, path.resolve(process.env.GITHUB_WORKSPACE));
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(process.env.HOME && path.isAbsolute(process.env.HOME));
  assert.equal(process.env.npm_config_userconfig && (await fs.readFile(process.env.npm_config_userconfig)).length, 0);
  assert.equal(process.env.npm_config_globalconfig && (await fs.readFile(process.env.npm_config_globalconfig)).length, 0);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) assert(!process.env[key], key);
  const manifest = JSON.parse(await pinned(manifestFile, manifestSha));
  const helperFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../actions/private-caller-boundary/h19/qualify.mjs');
  await pinned(helperFile, '202e5f8971ced93e63230a7cb57bf0ed364d1312d7094e18c81ad202ccbf2fd7');
  await pinned(path.join(path.dirname(helperFile), 'registry.mjs'), '749235e82913bce0286f059f9465d517824142fe67e536f46dd2b46ce05bc690');
  const { validateManifest } = await import(pathToFileURL(helperFile).href);
  validateManifest(manifest);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.release, '0.5.0'); assert.equal(manifest.complete, true);
  assert.equal(manifest.packages.length, 18);
  const cli = manifest.packages.find(row => row.name === '@askrjs/cli'); assert(cli);
  assert.equal(manifest.toolchain.node, '24.21.0'); assert.equal(manifest.toolchain.npm, '12.0.1');
  const originalInventory = JSON.parse(await pinned(inventoryFile, inventorySha));
  assert(Array.isArray(originalInventory) && originalInventory.length > 0 && originalInventory.length <= 4096);
  assert.equal(new Set(originalInventory.map(row => row.path)).size, originalInventory.length);
  assert.deepEqual(originalInventory.map(row => row.path), originalInventory.map(row => row.path).sort());
  for (const row of originalInventory) {
    safe(row.path); assert(!row.path.split('/').some(part => ['.git', 'node_modules'].includes(part)));
    assert(['100644', '100755'].includes(row.mode)); hex(row.sha256); assert.match(row.gitBlob, /^[a-f0-9]{40}$/u);
  }
  const output = path.resolve(outputArg);
  assert.equal(output, path.join(runner, `askr-final18-cli-tools-${manifestSha}`, process.platform));
  const outputParent = path.dirname(output);
  if (await missing(outputParent)) await fresh(outputParent);
  await fresh(output);
  await fresh(path.join(output, 'commands')); await fresh(path.join(output, 'payloads'));
  const write = async (name, value) => {
    safe(name); const raw = jsonBytes(value), file = path.join(output, name);
    await fs.writeFile(file, raw, { flag: 'wx', mode: 0o644 });
    return { file: name, sha256: sha(raw) };
  };
  const refArtifact = async file => ({ file: safe(path.relative(output, file).split(path.sep).join('/')), sha256: (await observed(file)).sha256 });
  const ownCommandRow = originalInventory.find(row => row.path === 'tests/helpers/owned-command.ts'); assert(ownCommandRow);
  await pinned(path.join(source, ownCommandRow.path), ownCommandRow.sha256);
  const { runOwnedCommand } = await import(pathToFileURL(path.join(source, ownCommandRow.path)).href);
  const commands = [], files = {}, probes = { platform: process.platform };
  const env = { ...process.env, VP_HOME: path.join(process.env.HOME, 'data', 'vite-plus') };
  const run = async (label, command, args, timeoutMs = 30000, commandEnv = env, cwd = source) => {
    let result;
    try { result = await runOwnedCommand({ command, args, cwd, evidence: path.join(output, 'commands'), label, timeoutMs, env: commandEnv }); }
    finally {
      const receiptFile = path.join(output, 'commands', `${label}.json`);
      if (!(await missing(receiptFile))) {
        const receipt = JSON.parse(await fs.readFile(receiptFile));
        commands.push({ label, exitCode: receipt.code, signal: receipt.signal, failure: receipt.failure ?? null, childClosed: receipt.childClosed,
          cleanupRequired: receipt.cleanup.required, treeReaped: receipt.cleanup.treeReaped, receipt: await refArtifact(receiptFile) });
      }
    }
    return { output: result.trim(), receipt: await refArtifact(path.join(output, 'commands', `${label}.json`)) };
  };
  const tool = async (file, token, payload = false) => {
    const row = await observed(file), ref = { file: token, sha256: row.sha256 };
    files[token] = { sha256: row.sha256, size: row.size };
    if (payload) {
      const name = `payloads/${sha(Buffer.from(token))}.json`;
      await fs.copyFile(file, path.join(output, name), fs.constants.COPYFILE_EXCL);
      await fs.chmod(path.join(output, name), row.mode);
      files[token].payload = { file: name, sha256: row.sha256 };
    }
    return ref;
  };
  const sourceObservation = async label => {
    const head = await run(`${label}-head`, 'git', ['rev-parse', 'HEAD']);
    const tree = await run(`${label}-tree`, 'git', ['rev-parse', 'HEAD^{tree}']);
    assert.equal(head.output, cli.commit); assert.equal(tree.output, cli.tree);
    const index = await run(`${label}-index`, 'git', ['ls-files', '--stage', '-z']);
    const stages = index.output.split('\0').filter(Boolean).map(value => { const [meta, name] = value.split('\t'); return { path: name, meta: meta.split(' ') }; });
    assert.equal(stages.length, originalInventory.length);
    const actual = [];
    for (const row of originalInventory) {
      const file = path.join(source, row.path), data = await observed(file), raw = await fs.readFile(file);
      const gitBlob = createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
      const stage = stages.find(item => item.path === row.path); assert(stage);
      assert.deepEqual(stage.meta, [row.mode, row.gitBlob, '0']);
      assert.equal(data.sha256, row.sha256); assert.equal(data.size, row.size); assert.equal(gitBlob, row.gitBlob);
      if (process.platform !== 'win32') assert.equal(data.mode, row.mode === '100755' ? 0o755 : 0o644);
      actual.push({ ...row });
    }
    const packageJsonSha256 = sha(await fs.readFile(path.join(source, 'package.json'))), lockSha256 = sha(await fs.readFile(path.join(source, 'package-lock.json')));
    assert.equal(packageJsonSha256, cli.packageJsonSha256); assert.equal(lockSha256, cli.lockSha256);
    return { head: head.output, tree: tree.output, inventorySha256: inventorySha, packageJsonSha256, lockSha256, files: actual };
  };
  const provenance = [], browsers = [];
  let failure = null, before, after, opensslRuntime, browserFailures = [], privateRemoved = false;
  const privateProbe = path.join(process.env.HOME, `openssl-probe-${manifestSha}`);
  try {
    before = await sourceObservation('source-before'); provenance.push(await write('source-before.json', before));
    const nodeExecutable = await tool(await fs.realpath(process.execPath), '@node');
    const npmPath = path.join(runner, 'askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js');
    const npmCli = await tool(npmPath, '@runner/askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js');
    assert.equal(npmCli.sha256, '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7');
    await run('normal-ci', process.execPath, [npmPath, 'ci'], 600000);
    const lock = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json')));
    const records = {};
    for (const name of ['typescript', '@typescript/native', 'playwright', 'playwright-core', 'vite-plus']) {
      const key = `node_modules/${name}`; assert(lock.packages[key]); records[key] = lock.packages[key];
    }
    provenance.push(await write('normal-lock-records.json', { lockSha256: cli.lockSha256, lockfileVersion: lock.lockfileVersion, records }));
    const installed = async (name, expectedName, version, cliPath) => {
      const dir = path.join(source, 'node_modules', name), pkgFile = path.join(dir, 'package.json'), pkg = JSON.parse(await fs.readFile(pkgFile));
      assert.equal(pkg.name, expectedName); assert.equal(pkg.version, version);
      assert.equal(records[`node_modules/${name}`].version, version);
      const packageJson = await tool(await fs.realpath(pkgFile), `@source/node_modules/${name}/package.json`, true);
      const cliRef = cliPath ? await tool(await fs.realpath(path.join(dir, cliPath)), `@source/node_modules/${name}/${cliPath}`) : null;
      return { packageJson, cli: cliRef, version };
    };
    const ts6 = await installed('typescript', '@typescript/typescript6', '6.0.2', 'bin/tsc6');
    const ts7 = await installed('@typescript/native', 'typescript', '7.0.2', 'bin/tsc');
    const pw = await installed('playwright', 'playwright', '1.63.0');
    const vp = await installed('vite-plus', 'vite-plus', '0.3.3');
    const corePkg = JSON.parse(await fs.readFile(path.join(source, 'node_modules/playwright-core/package.json')));
    assert.equal(corePkg.version, '1.63.0'); assert.equal(records['node_modules/playwright-core'].version, '1.63.0');
    const probe = async (label, command, args) => run(label, command, args);
    const nodeVersion = await probe('node-version', process.execPath, ['--version']); assert.equal(nodeVersion.output, 'v24.21.0');
    const npmVersion = await probe('npm-version', process.execPath, [npmPath, '--version']); assert.equal(npmVersion.output, '12.0.1');
    probes.node = { ref: nodeExecutable, version: nodeVersion.output, receipt: nodeVersion.receipt };
    probes.npm = { ref: npmCli, version: npmVersion.output, receipt: npmVersion.receipt };
    for (const [label, row, cliFile] of [['typescript6', ts6, 'node_modules/typescript/bin/tsc6'], ['typescript7', ts7, 'node_modules/@typescript/native/bin/tsc'],
      ['playwright', pw, 'node_modules/playwright/cli.js'], ['vitePlus', vp, 'node_modules/vite-plus/bin/vp']]) {
      const cliFileActual = await fs.realpath(path.join(source, cliFile));
      const measured = await probe(label === 'vitePlus' ? 'vite-plus-version' : `${label}-version`, process.execPath, [cliFileActual, '--version']);
      probes[label] = { ...(row.cli ? { cli: row.cli } : {}), packageJson: row.packageJson, packageVersion: row.version, reportedVersion: measured.output, receipt: measured.receipt };
    }
    provenance.push(await write('tool-probes.json', probes));

    // Finite system OpenSSL candidates. Copy bytes unchanged; discover actual
    // dependencies before claiming the copied fixture command works. No downloads.
    const candidates = process.platform === 'linux' ? ['/usr/bin/openssl'] : process.platform === 'darwin'
      ? ['/opt/homebrew/opt/openssl@3/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl', '/usr/bin/openssl']
      : ['C:\\Program Files\\OpenSSL\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];
    let opensslSource;
    for (const candidate of candidates) if (!(await missing(candidate))) { opensslSource = await fs.realpath(candidate); break; }
    assert(opensslSource, 'No supported actual OpenSSL source');
    const toolsRoot = path.join(runner, 'askr-final18-tools'); if (await missing(toolsRoot)) await fresh(toolsRoot);
    const runtimeDir = path.join(toolsRoot, 'openssl'); await fresh(runtimeDir);
    const copiedFiles = [], dependencyFiles = [], dependencyNames = [];
    const copyRuntime = async (sourceFile, basename) => {
      const row = await observed(sourceFile), target = path.join(runtimeDir, basename), runtimeToken = `@runner/askr-final18-tools/openssl/${basename}`;
      await fs.copyFile(sourceFile, target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, row.mode);
      assert.equal((await observed(target)).sha256, row.sha256);
      const payloadName = `payloads/openssl-${safe(basename)}`;
      await fs.copyFile(target, path.join(output, payloadName), fs.constants.COPYFILE_EXCL); await fs.chmod(path.join(output, payloadName), row.mode);
      copiedFiles.push({ source: sourceFile, destination: runtimeToken, mode: row.mode, size: row.size, sha256: row.sha256, payload: { file: payloadName, sha256: row.sha256 } });
      return { file: runtimeToken, sha256: row.sha256 };
    };
    const opensslExecutable = await copyRuntime(opensslSource, process.platform === 'win32' ? 'openssl.exe' : 'openssl');
    const executablePayload = copiedFiles[0];
    files[opensslExecutable.file] = { sha256: opensslExecutable.sha256, size: executablePayload.size, payload: executablePayload.payload };
    if (process.platform === 'win32') {
      // OpenSSL's installed adjacent runtime is copied as a whole finite DLL set;
      // Windows system loader dependencies remain explicitly OS-owned, not bundled.
      const directory = path.dirname(opensslSource);
      const dlls = (await fs.readdir(directory)).filter(name => /\.dll$/iu.test(name)).sort(); assert(dlls.length <= 128);
      for (const dll of dlls) {
        const sourceFile = await fs.realpath(path.join(directory, dll)), ref = await copyRuntime(sourceFile, dll), row = await observed(sourceFile);
        dependencyFiles.push({ file: sourceFile, mode: row.mode, size: row.size, sha256: row.sha256, copied: true, destination: ref.file });
      }
      for (const name of ['kernel32.dll', 'advapi32.dll', 'bcrypt.dll', 'crypt32.dll', 'ws2_32.dll', 'ucrtbase.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
        const file = path.join(process.env.SystemRoot, 'System32', name);
        if (await missing(file)) continue;
        const row = await observed(await fs.realpath(file)); dependencyFiles.push({ ...row, copied: false, destination: null });
      }
      dependencyNames.push('Observed adjacent DLL cohort plus finite Windows system runtime; actual copied certificate command is the compatibility proof. No complete Windows import-graph assertion.');
    } else {
      const dependencyProbe = await run('openssl-dependencies', process.platform === 'linux' ? '/usr/bin/ldd' : '/usr/bin/otool', process.platform === 'linux' ? [opensslSource] : ['-L', opensslSource]);
      const names = process.platform === 'linux'
        ? [...dependencyProbe.output.matchAll(/(?:=>\s*)?(\/[^\s]+)\s+\(/gu)].map(match => match[1])
        : dependencyProbe.output.split('\n').slice(1).map(line => line.trim().split(' (')[0]);
      assert(!dependencyProbe.output.includes('not found') && names.length > 0 && names.length <= 128);
      for (const name of [...new Set(names)]) {
        assert(path.isAbsolute(name), 'Unresolved relative/rpath OpenSSL dependency is unsupported');
        let physicalName;
        try { physicalName = await fs.realpath(name); }
        catch (error) {
          if (!osLoaderDependency(process.platform, name, error.code)) throw error;
          dependencyNames.push(`macOS OS-loader-provided dependency without a regular backing file: ${name}; exact name retained in openssl-dependencies raw receipt; no file hash or full OS-byte closure claimed.`);
          continue;
        }
        const row = await observed(physicalName); dependencyFiles.push({ ...row, copied: false, destination: null });
      }
    }
    await fresh(privateProbe); const certFile = path.join(privateProbe, 'fixture-ca.pem'), keyFile = path.join(privateProbe, 'fixture-tls.key');
    const config = path.join(privateProbe, 'openssl.cnf'); await fs.writeFile(config, '', { flag: 'wx', mode: 0o600 });
    const opensslEnv = { ...env, OPENSSL_CONF: config };
    const runtimeExecutable = path.join(runtimeDir, process.platform === 'win32' ? 'openssl.exe' : 'openssl');
    const opensslVersion = await run('openssl-version', runtimeExecutable, ['version'], 30000, opensslEnv, privateProbe);
    const expectedDNS = ['app.example.test', 'tenant.example.test', 'login.microsoftonline.com', 'accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'appleid.apple.com'];
    const certProbe = await run('openssl-certificate', runtimeExecutable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Owned starter protocol fixture', '-addext', `subjectAltName=${expectedDNS.map(name => `DNS:${name}`).join(',')}`, '-keyout', keyFile, '-out', certFile], 30000, opensslEnv, privateProbe);
    const certificate = new X509Certificate(await fs.readFile(certFile)), privateKey = createPrivateKey(await fs.readFile(keyFile));
    const keyMatches = certificate.publicKey.export({ format: 'der', type: 'spki' }).equals(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }));
    assert(keyMatches); assert.deepEqual(certificate.subjectAltName.split(', ').sort(), expectedDNS.map(name => `DNS:${name}`).sort());
    await fs.rm(privateProbe, { recursive: true }); privateRemoved = await missing(privateProbe); assert(privateRemoved);
    opensslRuntime = { sourceExecutable: { file: opensslSource, sha256: (await observed(opensslSource)).sha256 }, targetExecutable: opensslExecutable, copiedFiles, dependencyFiles,
      dependencyScope: dependencyNames, version: opensslVersion.output, versionReceipt: opensslVersion.receipt,
      certificateProbe: { exitCode: 0, receipt: certProbe.receipt, subjectAltName: certificate.subjectAltName, expectedDNS, keyMatches, privateProbeFilesRemoved: privateRemoved } };
    provenance.push(await write('openssl-runtime.json', opensslRuntime));

    if (process.platform === 'linux') {
      const store = path.join(runner, 'askr-final18-provider-browsers'); assert(await missing(store));
      env.PLAYWRIGHT_BROWSERS_PATH = store;
      await run('normal-browser-install', process.execPath, [npmPath, 'exec', '--no', '--', 'playwright', 'install', 'chromium', 'firefox', 'webkit'], 600000);
      // Set before import: Playwright computes registry paths during module loading.
      process.env.PLAYWRIGHT_BROWSERS_PATH = store;
      const { chromium, firefox, webkit } = await import(pathToFileURL(path.join(source, 'node_modules/playwright/index.mjs')).href);
      for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
        let server, browser, root, timer, polling = Promise.resolve(), active = false, browserClosed = false, serverClosed = false, drained = false;
        const seen = new Map(), history = [], cleanup = [], failures = [];
        const collect = async () => { const rows = root ? descendants(await snapshot(), root) : []; history.push({ at: Date.now(), rows }); for (const row of rows) seen.set(identity(row), row); };
        let executable, rootExecutable;
        try {
          const launcher = await fs.realpath(browserType.executablePath());
          assert(launcher.startsWith(store + path.sep));
          executable = await tool(launcher, `@runner/${path.relative(runner, launcher).split(path.sep).join('/')}`);
          server = await browserType.launchServer({ executablePath: launcher, headless: true, timeout: 30000, env });
          root = (await snapshot()).find(row => row.pid === server.process().pid); assert(root && root.startTime && root.executable);
          assert(root.executable.startsWith(store + path.sep));
          rootExecutable = await tool(await fs.realpath(root.executable), `@runner/${path.relative(runner, root.executable).split(path.sep).join('/')}`);
          await collect(); assert(seen.size > 0);
          timer = setInterval(() => { if (!active) { active = true; polling = collect().catch(error => failures.push(String(error))).finally(() => { active = false; }); } }, 50);
          browser = await browserType.connect(server.wsEndpoint(), { timeout: 10000 });
          const page = await browser.newPage(); await bounded(page.goto('data:text/html,<title>owned-tool-probe</title>'), 'browser probe', 10000);
          assert.equal(await bounded(page.title(), 'browser title', 10000), 'owned-tool-probe'); await bounded(page.close(), 'page close', 5000);
        } catch (error) { failures.push(String(error)); }
        finally {
          clearInterval(timer); await polling; if (root) await collect().catch(error => failures.push(String(error)));
          const deadline = performance.now() + 5000;
          await Promise.all([
            browser ? bounded(browser.close().then(() => { browserClosed = true; }), 'browser close', 5000).catch(error => failures.push(String(error))) : Promise.resolve(),
            server ? bounded(server.close().then(() => { serverClosed = true; }), 'server close', 5000).catch(error => failures.push(String(error))) : Promise.resolve(),
          ]);
          while (root && performance.now() <= deadline) {
            const rows = await snapshot(), remaining = [...seen.values()].map(row => rows.find(now => identity(now) === identity(row))).filter(Boolean);
            cleanup.push({ at: Date.now(), remaining });
            if (performance.now() <= deadline && remaining.every(row => row.state === 'Z')) { drained = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (!root || !seen.size || !browserClosed || !serverClosed || !drained) failures.push('Nonvacuous normal browser closure/drain unproven');
          if (server && !drained) await bounded(server.kill(), 'failed browser emergency kill; never acceptance', 1000).catch(error => failures.push(String(error)));
          const ownershipReceipt = await write(`browser-${name}-ownership.json`, { root, observed: [...seen.values()], history, cleanup, browserClosed, serverClosed, drained, failures });
          browsers.push({ name, executable, rootExecutable, root: root ? { pid: root.pid, startTime: root.startTime, executable: root.executable } : null,
            observedIdentities: [...seen.values()].map(row => ({ pid: row.pid, startTime: row.startTime, executable: row.executable })), browserClosed, serverClosed, drained, failures, ownershipReceipt });
          browserFailures.push(...failures);
        }
        assert.equal(failures.length, 0, `${name} actual owned browser failed`);
      }
    }
    provenance.push(await write('browser-probes.json', { platform: process.platform, records: browsers }));
    let terminationTool = null, systemRoot = null;
    if (process.platform === 'win32') {
      systemRoot = path.normalize(process.env.SystemRoot); assert.match(systemRoot, /^[A-Z]:\\/u);
      terminationTool = await tool(await fs.realpath(path.join(systemRoot, 'System32/taskkill.exe')), '@system/System32/taskkill.exe');
    }
    after = await sourceObservation('source-after'); assert.deepEqual(before, after); provenance.push(await write('source-after.json', after));
    const readback = { platform: process.platform, manifestSha256: manifestSha, sourceCommit: cli.commit, sourceTree: cli.tree, sourceInventorySha256: inventorySha,
      sourcePackageJsonSha256: cli.packageJsonSha256, sourceLockSha256: cli.lockSha256, helperCommit: HELPER.commit, helperTree: HELPER.tree,
      normalCommands: commands, allCommandsZero: commands.length > 0 && commands.every(row => row.exitCode === 0 && row.signal === null && row.failure === null && row.childClosed && (!row.cleanupRequired || row.treeReaped)),
      sourceInventoryBeforeAfterExact: true, sourceLockUnchanged: true, cleanupCertain: privateRemoved && browserFailures.length === 0,
      cleanupScope: 'Collector children/browser/private probe only; H20 helper cleanup remains a separately retained workflow step.', finalPlatformAdmission: false };
    assert(readback.allCommandsZero && readback.cleanupCertain); provenance.push(await write('readback.json', readback));
    await write('platform-tools.json', { nodeExecutable, terminationTool, systemRoot,
      tools: { npmCli, openssl: { executable: opensslRuntime.targetExecutable, version: opensslRuntime.version }, typescript6: ts6, typescript7: ts7,
        playwright: { packageJson: pw.packageJson, version: pw.version, browsers: browsers.map(({ name, executable, rootExecutable }) => ({ name, executable, rootExecutable })) } }, files, provenance });
  } catch (error) { failure = String(error.stack ?? error); }
  finally {
    if (!(await missing(privateProbe))) await fs.rm(privateProbe, { recursive: true }).catch(error => { failure = `${failure ?? ''}; private probe cleanup: ${error}`; });
    if (failure) {
      try { after = await sourceObservation('failed-source-after'); } catch (error) { failure += `; source-after: ${error}`; }
      await write('failure.json', { failure, platform: process.platform, manifestSha256: manifestSha, sourceCommit: cli.commit, sourceTree: cli.tree, normalCommands: commands,
        before: before ?? null, after: after ?? null, privateProbeFilesRemoved: await missing(privateProbe), browserRecords: browsers, finalPlatformAdmission: false });
    }
  }
  if (failure) throw new Error(failure);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
