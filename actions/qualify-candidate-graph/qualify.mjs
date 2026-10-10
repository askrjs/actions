import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOS = Object.freeze(
  Object.fromEntries(
    [
      'askr',
      'auth',
      'charts',
      'cli',
      'fetch',
      'i18n',
      'logos',
      'lucide',
      'monaco',
      'node',
      'orm',
      'otel',
      'schema',
      'server',
      'testing',
      'themes',
      'ui',
      'vite',
    ].map((name) => [
      `@askrjs/${name}`,
      `askrjs/${name === 'askr' ? 'askr' : 'askr-' + name}`,
    ])
  )
);
export const CONSUMERS = Object.freeze([
  'askrjs/askr-examples',
  'askrjs/website',
  'askrjs/destroyer',
  'askrjs/js-framework-benchmark',
]);
export function repositoryEntry(manifest, repository, phase) {
  assert.equal(
    typeof repository,
    'string',
    'GITHUB_REPOSITORY must name the checked-out repository'
  );
  const normalized = repository.toLowerCase();
  const entry = manifest.packages.find(
    (candidate) => candidate.repo.toLowerCase() === normalized
  );
  assert.ok(
    entry ||
      (['prepare', 'cleanup'].includes(phase) &&
        CONSUMERS.includes(normalized)),
    'candidate qualification supports only the 18 producers and Examples/Website/Destroyer/Askr benchmark consumers; verify-current requires a producer'
  );
  return entry;
}
export const sha = (bytes, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
export const sri = (bytes) =>
  'sha512-' + createHash('sha512').update(bytes).digest('base64');
const exactKeys = (object, expected, label) => {
  assert.ok(
    object && typeof object === 'object' && !Array.isArray(object),
    `${label} must be an object`
  );
  assert.deepEqual(
    Object.keys(object).sort(),
    [...expected].sort(),
    `${label}: unexpected or missing keys`
  );
};
export function validateManifest(manifest) {
  exactKeys(
    manifest,
    ['schemaVersion', 'release', 'complete', 'toolchain', 'packages'],
    'manifest'
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.release, '0.5.0');
  assert.equal(
    manifest.complete,
    true,
    'all 18 archives must be frozen before hosted qualification'
  );
  exactKeys(manifest.toolchain, ['node', 'npm'], 'toolchain');
  assert.deepEqual(manifest.toolchain, { node: '24.21.0', npm: '12.0.1' });
  assert.ok(Array.isArray(manifest.packages));
  assert.equal(manifest.packages.length, 18);
  const names = new Set();
  for (const entry of manifest.packages) {
    exactKeys(
      entry,
      [
        'name',
        'repo',
        'commit',
        'tree',
        'packageJsonSha256',
        'lockSha256',
        'archiveSha512',
      ],
      'package'
    );
    assert.equal(
      entry.repo,
      REPOS[entry.name],
      `unsupported package/repository: ${entry.name}`
    );
    assert.ok(!names.has(entry.name), `duplicate ${entry.name}`);
    names.add(entry.name);
    for (const key of ['commit', 'tree'])
      assert.match(entry[key], /^[a-f0-9]{40}$/, key);
    for (const key of ['packageJsonSha256', 'lockSha256'])
      assert.match(entry[key], /^[a-f0-9]{64}$/, key);
    assert.match(entry.archiveSha512, /^[a-f0-9]{128}$/);
  }
  assert.deepEqual([...names].sort(), Object.keys(REPOS).sort());
  return manifest;
}
export function command(commandName, args, options = {}) {
  const { trimOutput = true, logFile, ...spawnOptions } = options;
  const npmRoot = options.env?.RUNNER_TEMP || process.env.RUNNER_TEMP;
  const executable = commandName === 'npm' ? process.execPath : commandName;
  const executableArgs =
    commandName === 'npm'
      ? [
          join(
            npmRoot,
            'askr-candidate-toolchain/node_modules/npm/bin/npm-cli.js'
          ),
          ...args,
        ]
      : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...spawnOptions,
    shell: false,
  });
  if (logFile)
    writeFileSync(
      logFile,
      JSON.stringify({
        executable,
        args: executableArgs,
        cwd: options.cwd,
        status: result.status,
        error: result.error?.message,
      }) +
        '\n' +
        (result.stdout || '') +
        (result.stderr || '')
    );
  assert.equal(
    result.status,
    0,
    `${commandName} ${args.join(' ')} failed:\n${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`
  );
  return trimOutput ? result.stdout.trim() : result.stdout;
}
export async function checkedSource(entry, source) {
  const raw = await readFile(join(source, 'package.json'));
  assert.equal(
    sha(raw),
    entry.packageJsonSha256,
    `${entry.name}: package.json changed`
  );
  const lock = await readFile(join(source, 'package-lock.json'));
  assert.equal(sha(lock), entry.lockSha256, `${entry.name}: lock changed`);
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, '0.5.0');
  assert.equal(manifest.packageManager, 'npm@12.0.1');
  assert.equal(
    manifest.scripts?.prepack,
    'npm run build',
    'retain the reviewed normal prepack owner'
  );
  portableLock(manifest, JSON.parse(lock));
  return manifest;
}
export function portableLock(manifest, lock) {
  assert.equal(lock.name, manifest.name, 'lock package name differs');
  assert.equal(lock.version, '0.5.0', 'lock root version differs');
  assert.equal(
    lock.packages?.['']?.version,
    '0.5.0',
    'lock package root version differs'
  );
  for (const [location, entry] of Object.entries(lock.packages || {})) {
    const name = location.split('node_modules/').at(-1);
    if (!name.startsWith('@askrjs/')) continue;
    assert.ok(
      Object.hasOwn(REPOS, name),
      `unsupported internal lock package ${name}`
    );
    assert.equal(entry.version, '0.5.0', `${name}: noncandidate lock version`);
    assert.ok(
      !entry.link,
      `${name}: source links are not installed-consumer proof`
    );
    assert.equal(
      entry.resolved,
      `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-0.5.0.tgz`,
      `${name}: nonportable internal lock URL`
    );
    assert.match(
      entry.integrity,
      /^sha512-[A-Za-z0-9+/]+={0,2}$/,
      `${name}: immutable integrity required`
    );
  }
  return lock;
}
export function buildOrder(entries, packages) {
  const names = new Set(entries.map((entry) => entry.name));
  const waiting = new Map(
    entries.map((entry) => {
      const manifest = packages.get(entry.name);
      const dependencies = new Set();
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        for (const [name, range] of Object.entries(manifest[field] || {})) {
          if (!name.startsWith('@askrjs/')) continue;
          assert.ok(
            names.has(name),
            `${entry.name}: unsupported internal dependency ${name}`
          );
          assert.ok(
            range === '>=0.5.0 <0.6.0' || range === '0.5.0',
            `${entry.name}: unsupported ${name} range ${range}`
          );
          if (name !== entry.name) dependencies.add(name);
        }
      }
      return [entry.name, dependencies];
    })
  );
  const order = [];
  while (waiting.size) {
    const wave = [...waiting.keys()]
      .filter((name) => waiting.get(name).size === 0)
      .sort();
    assert.ok(
      wave.length,
      `cyclic complete build graph: ${[...waiting.keys()].join(', ')}`
    );
    order.push(...wave);
    for (const name of wave) waiting.delete(name);
    for (const dependencies of waiting.values())
      for (const name of wave) dependencies.delete(name);
  }
  return order;
}
export function packRecord(result) {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object'
      ? Object.values(result)
      : [];
  assert.equal(rows.length, 1, 'npm pack must return exactly one record');
  const filename = rows[0]?.filename;
  assert.equal(typeof filename, 'string');
  assert.ok(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(filename) &&
      basename(filename) === filename,
    'npm pack must return a portable .tgz basename'
  );
  return rows[0];
}
export async function packAndCheck(entry, source, destination, env) {
  await mkdir(destination, { recursive: true });
  const output = command(
    'npm',
    [
      'pack',
      '--json',
      '--foreground-scripts=false',
      '--pack-destination',
      destination,
    ],
    { cwd: source, env, logFile: join(destination, 'pack-command.log') }
  );
  await writeFile(join(destination, 'pack.json'), output + '\n');
  const record = packRecord(JSON.parse(output));
  const artifact = join(destination, record.filename);
  const bytes = await readFile(artifact);
  assert.equal(
    sha(bytes, 'sha512'),
    entry.archiveSha512,
    `${entry.name}: rebuilt archive bytes differ; do not replace the reviewed digest`
  );
  return {
    artifact,
    integrity: sri(bytes),
    shasum: sha(bytes, 'sha1'),
    archiveSha512: sha(bytes, 'sha512'),
  };
}
export async function register(root, entry, manifest, packed) {
  const file = join(root, 'catalog.json');
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(
    !catalog[entry.name],
    `${entry.name}: immutable catalog entry already exists`
  );
  const short = entry.name.split('/')[1];
  const tarball = `https://registry.npmjs.org/${entry.name}/-/${short}-0.5.0.tgz`;
  catalog[entry.name] = {
    ...packed,
    manifest: {
      ...manifest,
      dist: { tarball, integrity: packed.integrity, shasum: packed.shasum },
    },
  };
  await writeFile(file + '.new', JSON.stringify(catalog));
  await rename(file + '.new', file);
}
export async function publicGraph(manifest, get = fetch) {
  const proof = [];
  let missing = false;
  for (const entry of manifest.packages) {
    const response = await get(
      `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/0.5.0`,
      { signal: AbortSignal.timeout(60000) }
    );
    if (response.status === 404) {
      missing = true;
      proof.push({ name: entry.name, status: 404 });
      continue;
    }
    assert.equal(
      response.status,
      200,
      `${entry.name}: public registry request failed; absence is not established`
    );
    const current = await response.json();
    assert.equal(current.name, entry.name);
    assert.equal(current.version, '0.5.0');
    const expected =
      'sha512-' + Buffer.from(entry.archiveSha512, 'hex').toString('base64');
    assert.equal(
      current.dist?.integrity,
      expected,
      `${entry.name}: public version has different immutable bytes`
    );
    const short = entry.name.split('/')[1];
    assert.equal(
      current.dist?.tarball,
      `https://registry.npmjs.org/${entry.name}/-/${short}-0.5.0.tgz`
    );
    const archive = await get(current.dist.tarball, {
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(
      archive.status,
      200,
      `${entry.name}: public archive unavailable`
    );
    assert.equal(
      sha(Buffer.from(await archive.arrayBuffer()), 'sha512'),
      entry.archiveSha512,
      `${entry.name}: public archive mismatch`
    );
    proof.push({
      name: entry.name,
      status: 200,
      archiveSha512: entry.archiveSha512,
    });
  }
  return { complete: !missing, proof };
}
export async function exportEnvironment(registry, candidate) {
  await appendFile(
    process.env.GITHUB_ENV,
    `NPM_CONFIG_REGISTRY=${registry}\nnpm_config_@askrjs:registry=${registry}\nNPM_CONFIG_AUDIT=${candidate ? 'false' : 'true'}\n`
  );
}
export async function startRegistry(root) {
  await mkdir(root, { recursive: true });
  try {
    await readFile(join(root, 'server.json'));
    throw new Error(
      'existing registry metadata: use a fresh job root; never reuse an unidentified process'
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(join(root, 'catalog.json'), '{}\n');
  const log = await open(join(root, 'registry-process.log'), 'a');
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'registry.mjs'), root],
    {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
      env: process.env,
    }
  );
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `loopback registry exited ${child.exitCode}; inspect registry-process.log`
      );
    try {
      const info = JSON.parse(
        await readFile(join(root, 'server.json'), 'utf8')
      );
      assert.equal(info.pid, child.pid, 'stale registry process metadata');
      const health = await fetch(info.registry + '__askr-health', {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(
        (await health.json()).id,
        info.id,
        'registry readiness identity mismatch'
      );
      return info;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  throw new Error('loopback registry did not start within 10 seconds');
}
export async function stopRegistry(root) {
  try {
    const info = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));
    assert.ok(
      Number.isSafeInteger(info.pid) && info.pid > 0,
      'invalid owned process id'
    );
    const url = new URL(info.registry);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, 'http:');
    try {
      const prior = JSON.parse(
        await readFile(join(root, 'cleanup.json'), 'utf8')
      );
      if (prior.stopped && prior.id === info.id) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      process.kill(info.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    const health = await fetch(info.registry + '__askr-health', {
      signal: AbortSignal.timeout(2000),
    });
    const actual = await health.json();
    assert.equal(actual.id, info.id, 'refuse to stop an unrelated process');
    process.kill(info.pid);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(info.registry + '__askr-health', {
          signal: AbortSignal.timeout(200),
        });
      } catch {
        await writeFile(
          join(root, 'cleanup.json'),
          JSON.stringify({ stopped: true, pid: info.pid, id: info.id }) + '\n'
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('owned registry still answers after termination');
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}
const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
async function checkout(entry, source) {
  await mkdir(source, { recursive: true });
  const options = { cwd: source, env: gitEnv() };
  command('git', ['init', '--quiet'], options);
  command(
    'git',
    [
      '-c',
      'credential.helper=',
      'fetch',
      '--no-tags',
      '--depth=1',
      `https://github.com/${entry.repo}.git`,
      entry.commit,
    ],
    options
  );
  command(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      'checkout',
      '--quiet',
      '--detach',
      entry.commit,
    ],
    options
  );
  assert.equal(command('git', ['rev-parse', 'HEAD'], options), entry.commit);
  assert.equal(
    command('git', ['rev-parse', 'HEAD^{tree}'], options),
    entry.tree
  );
  return checkedSource(entry, source);
}
export async function assemble(
  manifest,
  root,
  sources,
  packages,
  registry,
  environment = process.env
) {
  const env = { ...environment };
  for (const key of Object.keys(env))
    if (/^npm_config_(registry|@askrjs:registry|audit|cache)$/i.test(key))
      delete env[key];
  Object.assign(env, {
    NPM_CONFIG_REGISTRY: registry,
    'npm_config_@askrjs:registry': registry,
    NPM_CONFIG_AUDIT: 'false',
    npm_config_cache: join(root, 'npm-cache'),
  });
  const order = buildOrder(manifest.packages, packages);
  const proof = [];
  await mkdir(join(root, 'logs'), { recursive: true });
  for (const name of order) {
    console.log(`Reconstructing ${name} from its frozen builder commit`);
    const entry = manifest.packages.find((entry) => entry.name === name);
    const source = sources.get(name);
    command('npm', ['ci'], {
      cwd: source,
      env,
      logFile: join(root, 'logs', name.split('/')[1] + '-ci.log'),
    });
    assert.equal(
      sha(await readFile(join(source, 'package-lock.json'))),
      entry.lockSha256,
      `${name}: npm ci changed the frozen lock`
    );
    const packed = await packAndCheck(
      entry,
      source,
      join(root, 'artifacts', name.split('/')[1]),
      env
    );
    command('git', ['diff', '--exit-code', 'HEAD', '--'], {
      cwd: source,
      env: gitEnv(),
    });
    await register(root, entry, packages.get(name), packed);
    // Archives live outside the checkout; the registry never needs these installed build dependencies.
    await rm(join(source, 'node_modules'), { recursive: true, force: true });
    proof.push({
      name,
      builderCommit: entry.commit,
      builderTree: entry.tree,
      ...packed,
    });
    await writeFile(
      join(root, 'assembly.json'),
      JSON.stringify({ order, proof }, null, 2) + '\n'
    );
  }
  return proof;
}
export function compareSourceHeads(builder, current) {
  assert.match(current, /^[a-f0-9]{40}$/);
  const options = { cwd: builder, env: gitEnv() };
  const files = command(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      'HEAD',
      current,
      '--',
    ],
    { ...options, trimOutput: false }
  )
    .split('\0')
    .filter(Boolean);
  assert.ok(
    files.every(
      (file) => file.startsWith('.github/workflows/') && /\.ya?ml$/.test(file)
    ),
    `final head changed outside CI workflows: ${files.join(', ')}`
  );
  const diff = command(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--binary',
      'HEAD',
      current,
      '--',
    ],
    { ...options, trimOutput: false }
  );
  return {
    files,
    diffSha256: sha(diff),
    finalTree: command('git', ['rev-parse', current + '^{tree}'], options),
  };
}
export async function changedWorkflowFiles(builder, current, repo) {
  const options = { cwd: builder, env: gitEnv() };
  command(
    'git',
    [
      '-c',
      'credential.helper=',
      'fetch',
      '--no-tags',
      '--depth=1',
      `https://github.com/${repo}.git`,
      current,
    ],
    options
  );
  return compareSourceHeads(builder, current);
}
async function main() {
  const {
    PHASE,
    MANIFEST_REF,
    MANIFEST_SHA256,
    RUNNER_TEMP,
    GITHUB_WORKSPACE,
    GITHUB_REPOSITORY,
    GITHUB_SHA,
  } = process.env;
  assert.ok(['prepare', 'verify-current', 'cleanup'].includes(PHASE));
  assert.match(MANIFEST_REF, /^[a-f0-9]{40}$/);
  assert.match(MANIFEST_SHA256, /^[a-f0-9]{64}$/);
  const root = join(RUNNER_TEMP, 'askr-0.5-candidate-' + MANIFEST_SHA256);
  if (PHASE === 'cleanup') {
    try {
      await stopRegistry(root);
    } finally {
      await exportEnvironment('https://registry.npmjs.org/', false);
    }
    return;
  }
  assert.equal(
    process.version,
    'v24.21.0',
    'use the frozen builder Node version'
  );
  assert.equal(
    command('npm', ['--version']),
    '12.0.1',
    'use the frozen builder npm version'
  );
  await mkdir(root, { recursive: true });
  const manifestFile = join(root, 'manifest.json');
  if (PHASE === 'prepare') {
    const response = await fetch(
      `https://raw.githubusercontent.com/askrjs/actions/${MANIFEST_REF}/fixtures/0.5.0-candidate-graph.json`,
      { signal: AbortSignal.timeout(60000) }
    );
    assert.equal(response.status, 200, 'frozen manifest unavailable');
    await writeFile(manifestFile, Buffer.from(await response.arrayBuffer()));
  }
  const raw = await readFile(manifestFile);
  assert.equal(
    sha(raw),
    MANIFEST_SHA256,
    'manifest bytes differ from reviewed inventory'
  );
  const manifest = validateManifest(JSON.parse(raw));
  const entry = repositoryEntry(manifest, GITHUB_REPOSITORY, PHASE);
  if (PHASE === 'prepare') {
    const available = await publicGraph(manifest);
    await writeFile(
      join(root, 'public-readback.json'),
      JSON.stringify(available, null, 2) + '\n'
    );
    if (available.complete) {
      await writeFile(
        join(root, 'mode.json'),
        JSON.stringify({
          mode: 'public',
          registry: 'https://registry.npmjs.org/',
        })
      );
      await exportEnvironment('https://registry.npmjs.org/', false);
      return;
    }
    const sources = new Map(),
      packages = new Map();
    for (const entry of manifest.packages) {
      const source = join(root, 'sources', entry.name.split('/')[1]);
      sources.set(entry.name, source);
      packages.set(entry.name, await checkout(entry, source));
    }
    const server = await startRegistry(root);
    try {
      await assemble(manifest, root, sources, packages, server.registry);
      await writeFile(
        join(root, 'mode.json'),
        JSON.stringify({ mode: 'candidate', registry: server.registry })
      );
      await exportEnvironment(server.registry, true);
    } catch (error) {
      await stopRegistry(root);
      throw error;
    }
    return;
  }
  const mode = JSON.parse(await readFile(join(root, 'mode.json'), 'utf8'));
  const current = command('git', ['rev-parse', 'HEAD'], {
    cwd: GITHUB_WORKSPACE,
  });
  assert.equal(
    current,
    GITHUB_SHA,
    'current checkout must be the actual CI event head'
  );
  command('git', ['diff', '--exit-code', 'HEAD', '--'], {
    cwd: GITHUB_WORKSPACE,
  });
  await checkedSource(entry, GITHUB_WORKSPACE);
  // Public mode did not need builder clones; fetch only this source for the changed-tree proof.
  const builder = join(root, 'sources', entry.name.split('/')[1]);
  if (mode.mode === 'public') await checkout(entry, builder);
  const changes = await changedWorkflowFiles(builder, current, entry.repo);
  const packed = await packAndCheck(
    entry,
    GITHUB_WORKSPACE,
    join(root, 'current-archive'),
    process.env
  );
  command('git', ['diff', '--exit-code', 'HEAD', '--'], {
    cwd: GITHUB_WORKSPACE,
  });
  await writeFile(
    join(root, 'current-head.json'),
    JSON.stringify(
      {
        package: entry.name,
        builderCommit: entry.commit,
        builderTree: entry.tree,
        finalCommit: current,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        npm: command('npm', ['--version']),
        ...changes,
        manifestRef: MANIFEST_REF,
        manifestSha256: MANIFEST_SHA256,
        mode: mode.mode,
        ...packed,
      },
      null,
      2
    ) + '\n'
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
