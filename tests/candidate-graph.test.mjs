import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, stat, lstat } from 'node:fs/promises';
import { join, delimiter, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRegistry } from '../actions/qualify-candidate-graph/registry.mjs';
import {
  validateManifest,
  REPOS,
  sha,
  command,
  checkedSource,
  buildOrder,
  packRecord,
  packAndCheck,
  register,
  startRegistry,
  stopRegistry,
  assemble,
  compareSourceHeads,
  publicGraph,
  portableLock,
  exportEnvironment,
  repositoryEntry,
} from '../actions/qualify-candidate-graph/qualify.mjs';

const root = join(
  process.env.RUNNER_TEMP || tmpdir(),
  'askr-candidate-tests',
  'run-' + new Date().toISOString().replaceAll(/[:.]/g, '-')
);
await mkdir(root, { recursive: true });
const report = {
  status: 'RUNNING',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  scope:
    'Release-specific synthetic normal-install/build fixtures. Not a complete18-package g2 or hosted qualification.',
  checks: [],
  failures: [],
  root,
};
const save = () =>
  writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const active = [];
const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv))
  if (
    /^npm_config_(registry|cache|audit|userconfig|globalconfig)$/i.test(key) ||
    /^(NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/.test(key)
  )
    delete baseEnv[key];
const pathKey =
  Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') || 'PATH';
baseEnv[pathKey] = [
  join(root, 'askr-candidate-toolchain/node_modules/.bin'),
  dirname(process.execPath),
  baseEnv[pathKey],
].join(delimiter);
Object.assign(baseEnv, {
  RUNNER_TEMP: root,
  NPM_CONFIG_CACHE: join(root, 'npm-cache'),
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_USERCONFIG: join(root, 'empty-user.npmrc'),
  NPM_CONFIG_GLOBALCONFIG: join(root, 'empty-global.npmrc'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
await writeFile(baseEnv.NPM_CONFIG_USERCONFIG, '');
await writeFile(baseEnv.NPM_CONFIG_GLOBALCONFIG, '');
const envFor = (registry) => ({
  ...baseEnv,
  NPM_CONFIG_REGISTRY: registry,
  'npm_config_@askrjs:registry': registry,
});
async function check(name, fn) {
  const result = { name, passed: false };
  try {
    result.detail = await fn();
    result.passed = true;
  } catch (e) {
    result.error = e.stack;
    report.failures.push({ name, error: e.stack });
  }
  report.checks.push(result);
  await save();
  console.log(name, result.passed ? 'PASS' : 'FAIL');
  return result;
}
async function cloneLocal(repo, head, destination) {
  await mkdir(destination, { recursive: true });
  const options = { cwd: destination, env: baseEnv };
  command('git', ['init', '--quiet'], options);
  command('git', ['fetch', '--no-tags', '--depth=1', repo, head], options);
  command(
    'git',
    ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', head],
    options
  );
  assert.equal(command('git', ['rev-parse', 'HEAD'], options), head);
  return destination;
}
function commit(source, message) {
  command('git', ['add', '--all'], { cwd: source, env: baseEnv });
  command(
    'git',
    [
      '-c',
      'user.name=External qualification fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { cwd: source, env: baseEnv }
  );
  return command('git', ['rev-parse', 'HEAD'], { cwd: source, env: baseEnv });
}
async function fixture(short, registry) {
  const source = join(root, 'fixture-inputs', short);
  await mkdir(source, { recursive: true });
  command('git', ['init', '--quiet'], { cwd: source, env: baseEnv });
  const manifest = {
    name: '@askrjs/' + short,
    version: '0.5.0',
    type: 'module',
    packageManager: 'npm@12.0.1',
    files: ['dist'],
    exports: { '.': './dist/index.js' },
    scripts: { build: 'node build.mjs', prepack: 'npm run build' },
    ...(short === 'auth'
      ? {
          peerDependencies: { '@askrjs/schema': '>=0.5.0 <0.6.0' },
          devDependencies: { '@askrjs/schema': '0.5.0' },
        }
      : {}),
  };
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  await writeFile(
    join(source, '.npmrc'),
    '@askrjs:registry=https://registry.npmjs.org\n'
  );
  await writeFile(
    join(source, '.gitignore'),
    'node_modules\ndist\nbuild-owner.json\n'
  );
  await writeFile(
    join(source, 'build.mjs'),
    `import {mkdir,writeFile,lstat,readFile} from 'node:fs/promises';import{pathToFileURL}from'node:url';\n${short === 'auth' ? "import {label} from '@askrjs/schema';" : "const label='external protocol fixture';"}\nawait mkdir('dist',{recursive:true});await writeFile('dist/index.js',${short === 'auth' ? JSON.stringify("export {label} from '@askrjs/schema';\n") : JSON.stringify("export const label='external protocol fixture';\n")});await writeFile('build-owner.json',JSON.stringify({node:process.version,npm:JSON.parse(await readFile(new URL('../package.json',pathToFileURL(process.env.npm_execpath)),'utf8')).version,label,peerLink:${short === 'auth' ? "(await lstat('node_modules/@askrjs/schema')).isSymbolicLink()" : 'false'}}));\n`
  );
  command('npm', ['install', '--package-lock-only'], {
    cwd: source,
    env: envFor(registry),
    logFile: join(root, short + '-fixture-lock.log'),
  });
  command('npm', ['ci'], {
    cwd: source,
    env: envFor(registry),
    logFile: join(root, short + '-fixture-ci.log'),
  });
  const head = commit(source, 'Freeze external synthetic ' + short + ' input');
  const raw = JSON.parse(
    command(
      'npm',
      [
        'pack',
        '--json',
        '--foreground-scripts=false',
        '--pack-destination',
        root,
      ],
      {
        cwd: source,
        env: envFor(registry),
        logFile: join(root, short + '-fixture-initial-pack.log'),
      }
    )
  );
  const record = packRecord(raw);
  const archive = join(root, record.filename),
    bytes = await readFile(archive);
  const entry = {
    name: manifest.name,
    repo: REPOS[manifest.name],
    commit: head,
    tree: command('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: source,
      env: baseEnv,
    }),
    packageJsonSha256: sha(await readFile(join(source, 'package.json'))),
    lockSha256: sha(await readFile(join(source, 'package-lock.json'))),
    archiveSha512: sha(bytes, 'sha512'),
  };
  await checkedSource(entry, source);
  return { entry, manifest, source, archive, raw };
}
async function registryRoot(name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ prototype: true, notFinalRelease: true })
  );
  const server = await startRegistry(dir);
  active.push(dir);
  return { root: dir, ...server };
}
const bootstrapCli = process.env.CANDIDATE_TEST_NPM_CLI;
assert.ok(
  bootstrapCli,
  'Set CANDIDATE_TEST_NPM_CLI to the bootstrap npm JS CLI (CI installs npm12.0.1 explicitly)'
);
try {
  assert.equal(process.version, 'v24.21.0');
  await check('Pinned toolchain actually installed and selected', async () => {
    command(
      process.execPath,
      [
        bootstrapCli,
        'install',
        '--prefix',
        join(root, 'askr-candidate-toolchain'),
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        'npm@12.0.1',
      ],
      {
        env: { ...baseEnv, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' },
        logFile: join(root, 'toolchain-install.log'),
      }
    );
    assert.equal(command('npm', ['--version'], { env: baseEnv }), '12.0.1');
    return {
      node: process.version,
      npm: '12.0.1',
      lifecyclePath: baseEnv[pathKey],
    };
  });
  await check(
    'Native command arguments stay literal even when caller requests a shell',
    async () => {
      const cwd = join(root, 'literal-command-control');
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(cwd, 'argv.mjs'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n'
      );
      const marker = join(cwd, 'shell-marker.txt');
      const args = [
        'literal & echo injected > shell-marker.txt',
        'literal; echo injected',
        '$(echo substitution)',
        '`echo substitution`',
        'a | b',
        'a > b',
        'quotes "and" spaces',
        'a\nb',
      ];
      for (const value of args) {
        const output = command(process.execPath, ['argv.mjs', value], {
          cwd,
          env: baseEnv,
          shell: true,
        });
        assert.deepEqual(JSON.parse(output), [value]);
        await assert.rejects(stat(marker), { code: 'ENOENT' });
      }
      return {
        literalArguments: args.length,
        shellOverrideIgnored: true,
        markerAbsent: true,
      };
    }
  );
  await check(
    'Public GET transport fixes npm origin and rejects actual redirect following',
    async () => {
      const nativeFetch = globalThis.fetch;
      let followed = 0;
      const calls = [];
      const target = createServer((request, response) => {
        followed++;
        response.end('redirect target must never be reached');
      });
      await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
      const upstream = createServer((request, response) => {
        if (request.url.startsWith('/redirect-fixture')) {
          response.writeHead(302, {
            location: `http://127.0.0.1:${target.address().port}/redirect-target`,
          });
          response.end();
        } else {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ path: request.url }));
        }
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const local = await createRegistry(
        join(root, 'literal-upstream-control')
      );
      try {
        globalThis.fetch = async (input, options) => {
          const url = new URL(String(input));
          assert.equal(url.origin, 'https://registry.npmjs.org');
          calls.push({ target: String(input), redirect: options.redirect });
          // Use native Node fetch and two real local servers to exercise the
          // same redirect option without issuing any public network request.
          return nativeFetch(
            `http://127.0.0.1:${upstream.address().port}${url.pathname}${url.search}`,
            options
          );
        };
        const rejected = await nativeFetch(
          local.info.registry + 'redirect-fixture?control=1'
        );
        await rejected.text();
        assert.equal(rejected.status, 502);
        assert.equal(followed, 0);
        assert.deepEqual(calls[0], {
          target: 'https://registry.npmjs.org/redirect-fixture?control=1',
          redirect: 'error',
        });
        const accepted = await nativeFetch(
          local.info.registry + 'plain%20metadata?view=source'
        );
        assert.equal(accepted.status, 200);
        assert.deepEqual(await accepted.json(), {
          path: '/plain%20metadata?view=source',
        });
        assert.deepEqual(calls[1], {
          target: 'https://registry.npmjs.org/plain%20metadata?view=source',
          redirect: 'error',
        });
        const count = calls.length;
        const invalid = await nativeFetch(
          local.info.registry + '/not-an-origin'
        );
        await invalid.text();
        assert.equal(invalid.status, 502);
        assert.equal(calls.length, count);
        return {
          actualRedirectRejected: true,
          redirectTargetRequests: followed,
          literalOrigin: true,
          encodedPathAndQueryPreserved: true,
        };
      } finally {
        globalThis.fetch = nativeFetch;
        for (const server of [local.server, upstream, target]) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      }
    }
  );
  await check(
    'Literal composite input guards reject moving references and executable text',
    async () => {
      const yaml = await readFile(
        new URL(
          '../actions/qualify-candidate-graph/action.yml',
          import.meta.url
        ),
        'utf8'
      );
      const lines = yaml.split('\n');
      const index = lines.findIndex((line) => line.trim() === 'run: |');
      assert.ok(index >= 0);
      const indentation = lines[index].length - lines[index].trimStart().length;
      const body = [];
      for (let offset = index + 1; offset < lines.length; offset++) {
        const line = lines[offset];
        if (line.trim() && line.length - line.trimStart().length <= indentation)
          break;
        body.push(line.slice(indentation + 2));
      }
      const env = {
        ...baseEnv,
        PHASE: 'prepare',
        MANIFEST_REF: 'b'.repeat(40),
        MANIFEST_SHA256: 'a'.repeat(64),
      };
      for (const phase of ['prepare', 'verify-current', 'cleanup'])
        command('bash', ['-e', '-c', body.join('\n')], {
          env: { ...env, PHASE: phase },
        });
      for (const invalid of [
        { PHASE: 'publish' },
        { PHASE: '$(touch should-not-exist)' },
        { MANIFEST_REF: 'main' },
        { MANIFEST_SHA256: 'a'.repeat(63) },
      ]) {
        assert.throws(() =>
          command('bash', ['-e', '-c', body.join('\n')], {
            cwd: root,
            env: { ...env, ...invalid },
          })
        );
      }
      await assert.rejects(lstat(join(root, 'should-not-exist')), {
        code: 'ENOENT',
      });
      return {
        literalYamlGuardExecuted: true,
        validPhases: 3,
        unsafeCoordinatesRejected: true,
        inputNeverExecuted: true,
      };
    }
  );
  await check(
    'Composite restores npm12 for both prepare and verify-current lifecycles',
    async () => {
      const yaml = await readFile(
        new URL(
          '../actions/qualify-candidate-graph/action.yml',
          import.meta.url
        ),
        'utf8'
      );
      const section = yaml
        .split('    - name: Restore the frozen npm CLI after Node setup\n')[1]
        ?.split('    - name:')[0];
      assert.ok(section);
      assert.match(section, /if: inputs.phase != 'cleanup'/);
      const body = section
        .split('      run: |\n')[1]
        .split('\n')
        .map((line) => line.slice(8))
        .join('\n');
      const output = join(root, 'restored-npm-path');
      const priorEnv = {
        ...baseEnv,
        [pathKey]: [dirname(process.execPath), baseEnv[pathKey]].join(
          delimiter
        ),
        GITHUB_PATH: output,
      };
      command('bash', ['-e', '-c', body], { env: priorEnv });
      const added = (await readFile(output, 'utf8')).trim();
      const restored = {
        ...priorEnv,
        [pathKey]: added + delimiter + priorEnv[pathKey],
      };
      assert.equal(
        command('bash', ['-e', '-c', 'npm --version'], { env: restored }),
        '12.0.1'
      );
      return {
        literalSelectionBlockExecuted: true,
        selectionAppliesToPrepareAndVerification: true,
        selectedNpm: '12.0.1',
      };
    }
  );
  await check(
    'Strict final manifest rejects incomplete template and duplicate/malformed inputs',
    async () => {
      const template = JSON.parse(
        await readFile(
          join(
            import.meta.dirname,
            '../fixtures/0.5.0-candidate-graph.TEMPLATE.json'
          )
        )
      );
      assert.throws(() => validateManifest(template));
      const manifest = {
        schemaVersion: 1,
        release: '0.5.0',
        complete: true,
        toolchain: { node: '24.21.0', npm: '12.0.1' },
        packages: Object.entries(REPOS).map(([name, repo]) => ({
          name,
          repo,
          commit: '1'.repeat(40),
          tree: '2'.repeat(40),
          packageJsonSha256: '3'.repeat(64),
          lockSha256: '4'.repeat(64),
          archiveSha512: '5'.repeat(128),
        })),
      };
      validateManifest(manifest);
      const duplicate = structuredClone(manifest);
      duplicate.packages[17] = duplicate.packages[0];
      assert.throws(() => validateManifest(duplicate));
      const unknown = structuredClone(manifest);
      unknown.packages[0].repo = 'attacker/other';
      assert.throws(() => validateManifest(unknown));
      report.syntheticCompleteManifest = manifest;
      return {
        strictEntries: 18,
        templateRejected: true,
        duplicatesRejected: true,
        wrongRepoRejected: true,
      };
    }
  );
  const seed = await registryRoot('seed-registry');
  let schema, auth;
  await check(
    'Normal npm12 pack runs native prepack and preserves object JSON shape',
    async () => {
      schema = await fixture('schema', seed.registry);
      assert.ok(!Array.isArray(schema.raw));
      assert.equal(
        JSON.parse(await readFile(join(schema.source, 'build-owner.json')))
          .node,
        'v24.21.0'
      );
      await register(seed.root, schema.entry, schema.manifest, {
        artifact: schema.archive,
        integrity:
          'sha512-' +
          Buffer.from(schema.entry.archiveSha512, 'hex').toString('base64'),
        shasum: sha(await readFile(schema.archive), 'sha1'),
        archiveSha512: schema.entry.archiveSha512,
      });
      auth = await fixture('auth', seed.registry);
      assert.equal(
        JSON.parse(await readFile(join(auth.source, 'build-owner.json'))).node,
        'v24.21.0'
      );
      assert.equal(
        packRecord([{ filename: 'allowed.tgz' }]).filename,
        'allowed.tgz'
      );
      for (const filename of [
        '../escape.tgz',
        'bad\\path.tgz',
        'bad\npath.tgz',
        '.tgz',
      ])
        assert.throws(() => packRecord({ only: { filename } }));
      return {
        shape: 'object keyed by scoped name',
        schema: schema.entry,
        auth: auth.entry,
      };
    }
  );
  const assembly = await registryRoot('assembly');
  let sources, packages;
  await check(
    'Progressive normal npm ci + prepack reconstructs immutable synthetic dependency graph',
    async () => {
      assert.ok(schema && auth);
      sources = new Map();
      packages = new Map();
      for (const f of [schema, auth]) {
        const source = await cloneLocal(
          f.source,
          f.entry.commit,
          join(root, 'builders', f.entry.name.split('/')[1])
        );
        sources.set(f.entry.name, source);
        packages.set(f.entry.name, await checkedSource(f.entry, source));
      }
      assert.deepEqual(buildOrder([auth.entry, schema.entry], packages), [
        '@askrjs/schema',
        '@askrjs/auth',
      ]);
      const proof = await assemble(
        { packages: [auth.entry, schema.entry] },
        assembly.root,
        sources,
        packages,
        assembly.registry,
        baseEnv
      );
      for (const f of [schema, auth]) {
        const owner = JSON.parse(
          await readFile(join(sources.get(f.entry.name), 'build-owner.json'))
        );
        assert.equal(owner.node, 'v24.21.0');
        assert.equal(owner.npm, '12.0.1');
      }
      for (const source of sources.values())
        await assert.rejects(lstat(join(source, 'node_modules')), {
          code: 'ENOENT',
        });
      const installedPeer = JSON.parse(
        await readFile(join(sources.get(auth.entry.name), 'build-owner.json'))
      );
      assert.equal(installedPeer.label, 'external protocol fixture');
      assert.equal(installedPeer.peerLink, false);
      return { order: proof.map((p) => p.name), proof };
    }
  );
  await check(
    'Build graph rejects cycles and unsupported peer ranges without bypass',
    async () => {
      const manifests = new Map([
        ['@askrjs/schema', { devDependencies: { '@askrjs/auth': '0.5.0' } }],
        [
          '@askrjs/auth',
          { peerDependencies: { '@askrjs/schema': '>=0.5.0 <0.6.0' } },
        ],
      ]);
      assert.throws(
        () => buildOrder([schema.entry, auth.entry], manifests),
        /cyclic/
      );
      manifests.set('@askrjs/schema', {});
      manifests.set('@askrjs/auth', {
        peerDependencies: { '@askrjs/schema': '*' },
      });
      assert.throws(
        () => buildOrder([schema.entry, auth.entry], manifests),
        /unsupported/
      );
      return { cyclesRejected: true, unboundedRangeRejected: true };
    }
  );
  await check(
    'Normal independent scoped/unscoped installs use physical0.5 packages with canonical locks',
    async () => {
      for (const phase of ['install', 'ci']) {
        const destination = join(root, 'consumer-' + phase);
        await mkdir(destination, { recursive: true });
        await writeFile(
          join(destination, 'package.json'),
          JSON.stringify({
            name: 'external-consumer',
            version: '0.5.0',
            private: true,
            type: 'module',
            dependencies: {
              '@askrjs/auth': '0.5.0',
              '@askrjs/schema': '0.5.0',
            },
          })
        );
        await writeFile(
          join(destination, '.npmrc'),
          '@askrjs:registry=https://registry.npmjs.org\n'
        );
        if (phase === 'ci')
          await cp(
            join(root, 'consumer-install/package-lock.json'),
            join(destination, 'package-lock.json')
          );
        command('npm', [phase], {
          cwd: destination,
          env: envFor(assembly.registry),
          logFile: join(root, 'consumer-' + phase + '.log'),
        });
        const ls = JSON.parse(
          command('npm', ['ls', '--all', '--json'], {
            cwd: destination,
            env: envFor(assembly.registry),
          })
        );
        assert.equal(ls.dependencies['@askrjs/auth'].version, '0.5.0');
        assert.equal(ls.dependencies['@askrjs/schema'].version, '0.5.0');
        const lock = JSON.parse(
          await readFile(join(destination, 'package-lock.json'))
        );
        portableLock({ name: 'external-consumer' }, lock);
        for (const name of ['auth', 'schema'])
          assert.equal(
            (
              await (
                await import('node:fs/promises')
              ).lstat(join(destination, 'node_modules/@askrjs', name))
            ).isSymbolicLink(),
            false
          );
        const code =
          "import {label} from '@askrjs/auth';if(label!=='external protocol fixture')throw Error('bad import');";
        command(process.execPath, ['--input-type=module', '--eval', code], {
          cwd: destination,
          env: envFor(assembly.registry),
        });
      }
      const env = envFor(assembly.registry);
      delete env['npm_config_@askrjs:registry'];
      assert.equal(
        command('npm', ['config', 'get', '@askrjs:registry'], {
          cwd: join(root, 'consumer-install'),
          env,
        }),
        'https://registry.npmjs.org'
      );
      assert.equal(
        command('npm', ['config', 'get', '@askrjs:registry'], {
          cwd: join(root, 'consumer-install'),
          env: envFor(assembly.registry),
        }),
        assembly.registry
      );
      return {
        normalInstall: true,
        independentNormalCi: true,
        scopeOverrideRequired: true,
        canonicalLockUrls: true,
        noProducerLinks: true,
      };
    }
  );
  await check(
    'GET-only registry denies mutations, unknown Askr names and unreviewed versions',
    async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD'])
        assert.equal(
          (await fetch(assembly.registry + '@askrjs/schema', { method }))
            .status,
          405
        );
      for (const path of [
        '@askrjs/not-reviewed',
        '@askrjs/schema/0.4.0',
        '@askrjs/schema/0.5.0-rc.1',
      ])
        assert.equal((await fetch(assembly.registry + path)).status, 404);
      const data = await (
        await fetch(assembly.registry + '@askrjs%2fschema')
      ).json();
      assert.deepEqual(Object.keys(data.versions), ['0.5.0']);
      assert.equal(
        data.versions['0.5.0'].dist.tarball,
        'https://registry.npmjs.org/@askrjs/schema/-/schema-0.5.0.tgz'
      );
      const unknown = (
        await readFile(join(assembly.root, 'requests.jsonl'), 'utf8')
      )
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
        .filter((x) => x.kind === 'candidate-missing');
      assert.ok(unknown.length);
      return {
        mutationMethodsRejected: 4,
        unknownCandidateNoPublicFallback: true,
        onlyExactReviewedVersion: true,
      };
    }
  );
  await check(
    'Asynchronous digest/registration guards execute against real archives',
    async () => {
      await assert.rejects(
        register(assembly.root, schema.entry, schema.manifest, {}),
        /already exists/
      );
      await assert.rejects(
        packAndCheck(
          { ...schema.entry, archiveSha512: '0'.repeat(128) },
          sources.get(schema.entry.name),
          join(root, 'wrong-digest-pack'),
          envFor(assembly.registry)
        ),
        /bytes differ/
      );
      const catalog = JSON.parse(
        await readFile(join(assembly.root, 'catalog.json'))
      );
      const file = catalog[schema.entry.name].artifact,
        bytes = await readFile(file);
      try {
        await writeFile(file, Buffer.concat([bytes, Buffer.from('tampered')]));
        assert.equal(
          (await fetch(assembly.registry + '@askrjs/schema/-/schema-0.5.0.tgz'))
            .status,
          502
        );
      } finally {
        await writeFile(file, bytes);
      }
      assert.equal(
        (await fetch(assembly.registry + '@askrjs/schema/-/schema-0.5.0.tgz'))
          .status,
        200
      );
      return {
        wrongExpectedDigestRejected: true,
        changedRegisteredBytesRejected: true,
        duplicateRegistrationRejected: true,
      };
    }
  );
  await check(
    'Portable lock guard rejects local URLs, links and older internal versions',
    async () => {
      const lock = JSON.parse(
        await readFile(join(root, 'consumer-install/package-lock.json'))
      );
      for (const mutate of [
        (x) => (x.resolved = 'http://127.0.0.1:1234/schema.tgz'),
        (x) => (x.link = true),
        (x) => (x.version = '0.4.0'),
      ]) {
        const bad = structuredClone(lock);
        mutate(bad.packages['node_modules/@askrjs/schema']);
        assert.throws(() => portableLock({ name: 'external-consumer' }, bad));
      }
      return {
        localhostRejected: true,
        linksRejected: true,
        oldVersionsRejected: true,
      };
    }
  );
  await check(
    'Builder/current source distinction permits workflow-only delta and requires identical pack bytes',
    async () => {
      const builder = sources.get(schema.entry.name),
        current = await cloneLocal(
          schema.source,
          schema.entry.commit,
          join(root, 'current-workflow-only')
        );
      await mkdir(join(current, '.github/workflows'), { recursive: true });
      await writeFile(
        join(current, '.github/workflows/candidate-prototype.yml'),
        'name: External fixture\non: workflow_dispatch\njobs: {}\n'
      );
      const head = commit(current, 'External workflow-only test delta');
      command('git', ['fetch', '--no-tags', current, head], {
        cwd: builder,
        env: baseEnv,
      });
      const changes = compareSourceHeads(builder, head);
      assert.deepEqual(changes.files, [
        '.github/workflows/candidate-prototype.yml',
      ]);
      await checkedSource(schema.entry, current);
      command('npm', ['ci'], {
        cwd: current,
        env: envFor(assembly.registry),
        logFile: join(root, 'workflow-current-ci.log'),
      });
      const packed = await packAndCheck(
        schema.entry,
        current,
        join(root, 'current-workflow-pack'),
        envFor(assembly.registry)
      );
      for (const bad of [
        'src/unreviewed.js',
        ' .github/workflows/leading-space.yml',
      ]) {
        await mkdir(dirname(join(current, bad)), { recursive: true });
        await writeFile(join(current, bad), 'unreviewed');
        const badHead = commit(
          current,
          'External source delta rejection fixture'
        );
        command('git', ['fetch', '--no-tags', current, badHead], {
          cwd: builder,
          env: baseEnv,
        });
        assert.throws(
          () => compareSourceHeads(builder, badHead),
          /outside CI workflows/
        );
      }
      return {
        builderCommit: schema.entry.commit,
        builderTree: schema.entry.tree,
        finalWorkflowCommit: head,
        ...changes,
        archiveSha512: packed.archiveSha512,
        sourceDeltaRejected: true,
        leadingWhitespacePathRejected: true,
      };
    }
  );
  await check(
    'Public mode requires every exact archive and fails on immutable mismatches',
    async () => {
      const entries = report.syntheticCompleteManifest.packages.map((x) => ({
        ...x,
        archiveSha512: schema.entry.archiveSha512,
      }));
      const bytes = await readFile(schema.archive);
      const response = async (url) =>
        url.endsWith('.tgz')
          ? new Response(bytes)
          : new Response(
              JSON.stringify({
                name: decodeURIComponent(new URL(url).pathname.split('/')[1]),
                version: '0.5.0',
                dist: {
                  integrity:
                    'sha512-' +
                    Buffer.from(schema.entry.archiveSha512, 'hex').toString(
                      'base64'
                    ),
                  tarball: `https://registry.npmjs.org/${decodeURIComponent(new URL(url).pathname.split('/')[1])}/-/${decodeURIComponent(new URL(url).pathname.split('/')[1]).split('/')[1]}-0.5.0.tgz`,
                },
              }),
              { headers: { 'content-type': 'application/json' } }
            );
      assert.equal(
        (await publicGraph({ packages: entries }, response)).complete,
        true
      );
      assert.equal(
        (
          await publicGraph(
            { packages: entries },
            async () => new Response('{}', { status: 404 })
          )
        ).complete,
        false
      );
      await assert.rejects(
        publicGraph(
          { packages: entries },
          async () => new Response('{}', { status: 500 })
        ),
        /absence is not established/
      );
      await assert.rejects(
        publicGraph(
          { packages: entries },
          async () =>
            new Response(
              JSON.stringify({
                name: entries[0].name,
                version: '0.5.0',
                dist: { integrity: 'wrong' },
              })
            )
        ),
        /different immutable bytes/
      );
      return {
        all18Required: true,
        missingMeansCandidateMode: true,
        serverFailureNotAbsence: true,
        mismatchFailsClosed: true,
        network: 'deterministic response fixtures, not public0.5 evidence',
      };
    }
  );
  await check(
    'Cleanup identifies owned server, rejects stale reuse and restores registry environment',
    async () => {
      await assert.rejects(
        startRegistry(assembly.root),
        /existing registry metadata/
      );
      const info = JSON.parse(
        await readFile(join(assembly.root, 'server.json'))
      );
      await writeFile(
        join(assembly.root, 'server.json'),
        JSON.stringify({ ...info, id: 'unrelated' })
      );
      await assert.rejects(stopRegistry(assembly.root), /unrelated/);
      assert.equal(
        (await fetch(assembly.registry + '__askr-health')).status,
        200
      );
      await writeFile(join(assembly.root, 'server.json'), JSON.stringify(info));
      await stopRegistry(assembly.root);
      await stopRegistry(assembly.root);
      await assert.rejects(
        fetch(assembly.registry + '__askr-health', {
          signal: AbortSignal.timeout(1000),
        })
      );
      const githubEnv = join(root, 'github-env');
      process.env.GITHUB_ENV = githubEnv;
      await exportEnvironment(assembly.registry, true);
      await exportEnvironment('https://registry.npmjs.org/', false);
      const lines = await readFile(githubEnv, 'utf8');
      assert.ok(
        lines.endsWith(
          'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/\nnpm_config_@askrjs:registry=https://registry.npmjs.org/\nNPM_CONFIG_AUDIT=true\n'
        )
      );
      return {
        unrelatedProcessNeverKilled: true,
        staleStartRejected: true,
        idempotentStop: true,
        serverNoLongerReachable: true,
        scopedAndUnscopedEnvReset: true,
      };
    }
  );
  await check(
    'Only known consumers may prepare; current-archive proof stays producer-only',
    async () => {
      for (const repo of [
        'askrjs/askr-examples',
        'askrjs/website',
        'askrjs/destroyer',
        'askrjs/js-framework-benchmark',
      ]) {
        assert.equal(
          repositoryEntry(report.syntheticCompleteManifest, repo, 'prepare'),
          undefined
        );
        assert.equal(
          repositoryEntry(report.syntheticCompleteManifest, repo, 'cleanup'),
          undefined
        );
        assert.throws(
          () =>
            repositoryEntry(
              report.syntheticCompleteManifest,
              repo,
              'verify-current'
            ),
          /requires a producer/
        );
      }
      assert.ok(
        repositoryEntry(
          report.syntheticCompleteManifest,
          'AskrJS/Askr',
          'verify-current'
        )
      );
      assert.throws(() =>
        repositoryEntry(
          report.syntheticCompleteManifest,
          'other/website',
          'prepare'
        )
      );
      for (const repo of [
        'askrjs/js-framework-benchmark-evil',
        'fork/js-framework-benchmark',
      ]) {
        for (const phase of ['prepare', 'cleanup'])
          assert.throws(() =>
            repositoryEntry(report.syntheticCompleteManifest, repo, phase)
          );
      }
      assert.throws(() =>
        repositoryEntry(
          report.syntheticCompleteManifest,
          'askrjs/js-framework-benchmark',
          'publish'
        )
      );
      return {
        consumers: 4,
        benchmarkPrepareAndCleanupOnly: true,
        producerOnlyCurrentProof: true,
        unknownRejected: true,
      };
    }
  );
  await check(
    'Normal prepack may not silently mutate the frozen tracked source',
    async () => {
      const source = await cloneLocal(
        schema.source,
        schema.entry.commit,
        join(root, 'mutating-builder')
      );
      await writeFile(join(source, 'tracked.txt'), 'approved');
      await writeFile(
        join(source, 'build.mjs'),
        (await readFile(join(source, 'build.mjs'), 'utf8')) +
          "\nawait writeFile('tracked.txt','changed by prepack');\n"
      );
      const head = commit(source, 'Freeze mutating-prepack negative fixture');
      const entry = {
        ...schema.entry,
        commit: head,
        tree: command('git', ['rev-parse', 'HEAD^{tree}'], {
          cwd: source,
          env: baseEnv,
        }),
      };
      const server = await registryRoot('mutating-source-registry');
      await assert.rejects(
        assemble(
          { packages: [entry] },
          server.root,
          new Map([[entry.name, source]]),
          new Map([[entry.name, schema.manifest]]),
          server.registry,
          baseEnv
        ),
        /git diff --exit-code/
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(server.root, 'catalog.json'))),
        {}
      );
      return {
        trackedMutationRejected: true,
        unapprovedArchiveNotRegistered: true,
      };
    }
  );
  await check(
    'Literal cleanup phase crosses a real detached-process boundary and rejects publication phase',
    async () => {
      const manifestSha = 'a'.repeat(64),
        serverRoot = join(root, 'literal', 'askr-0.5-candidate-' + manifestSha);
      await mkdir(join(root, 'literal'), { recursive: true });
      const helper = fileURLToPath(
        new URL(
          '../actions/qualify-candidate-graph/qualify.mjs',
          import.meta.url
        )
      );
      const script = join(root, 'start-owned-registry.mjs');
      await writeFile(
        script,
        `import {startRegistry} from ${JSON.stringify(new URL('../actions/qualify-candidate-graph/qualify.mjs', import.meta.url).href)};console.log(JSON.stringify(await startRegistry(${JSON.stringify(serverRoot)})));\n`
      );
      const info = JSON.parse(
        command(process.execPath, [script], { env: baseEnv })
      );
      active.push(serverRoot);
      assert.equal((await fetch(info.registry + '__askr-health')).status, 200);
      const env = {
        ...baseEnv,
        PHASE: 'cleanup',
        MANIFEST_REF: 'b'.repeat(40),
        MANIFEST_SHA256: manifestSha,
        RUNNER_TEMP: join(root, 'literal'),
        GITHUB_ENV: join(root, 'literal/github-env'),
      };
      command(process.execPath, [helper], {
        env,
        logFile: join(root, 'literal-cleanup.log'),
      });
      command(process.execPath, [helper], {
        env,
        logFile: join(root, 'literal-cleanup-repeat.log'),
      });
      await assert.rejects(
        fetch(info.registry + '__askr-health', {
          signal: AbortSignal.timeout(1000),
        })
      );
      assert.ok(
        (await readFile(env.GITHUB_ENV, 'utf8')).includes(
          'npm_config_@askrjs:registry=https://registry.npmjs.org/'
        )
      );
      assert.throws(() =>
        command(process.execPath, [helper], {
          env: { ...env, PHASE: 'publish' },
          logFile: join(root, 'invalid-phase.log'),
        })
      );
      return {
        survivedStartingProcessExit: true,
        cleanupStopsOwnedProcess: true,
        idempotent: true,
        registryMappingsReset: true,
        publicationPhaseRejected: true,
      };
    }
  );
  await check(
    'Literal hosted fixture setup and assertions require real owned-process cleanup',
    async () => {
      const yaml = await readFile(
        new URL('../.github/workflows/ci.yml', import.meta.url),
        'utf8'
      );
      const extract = (name) => {
        const section = yaml
          .split('      - name: ' + name + '\n')[1]
          ?.split('      - name:')[0];
        assert.ok(section, name);
        const lines = section.split('      run: |\n')[1].split('\n');
        const body = [];
        for (const line of lines) {
          if (line.trim() && !line.startsWith('          ')) break;
          body.push(line.slice(10));
        }
        return body
          .join('\n')
          .replace(/^node --input-type=module <<'JS'\n/, '')
          .replace(/\nJS\s*$/, '');
      };
      const cwd = fileURLToPath(new URL('..', import.meta.url));
      const digest = sha(
        await readFile(
          join(cwd, 'fixtures/0.5.0-candidate-graph.TEMPLATE.json')
        )
      );
      const env = {
        ...baseEnv,
        RUNNER_TEMP: join(root, 'actual-ci-cleanup'),
        MANIFEST_SHA256: digest,
        MANIFEST_REF: 'b'.repeat(40),
        PHASE: 'cleanup',
        GITHUB_ENV: join(root, 'actual-ci-env'),
      };
      const serverRoot = join(env.RUNNER_TEMP, 'askr-0.5-candidate-' + digest);
      const start = extract(
        'Start an owned fixture at the actual composite cleanup root'
      );
      const verify = extract(
        'Prove the actual composite stopped its owned detached fixture'
      );
      command(process.execPath, ['--input-type=module', '-'], {
        cwd,
        env,
        input: start,
        logFile: join(root, 'actual-ci-start.log'),
      });
      active.push(serverRoot);
      const info = JSON.parse(
        await readFile(join(serverRoot, 'server.json'), 'utf8')
      );
      assert.equal((await fetch(info.registry + '__askr-health')).status, 200);
      assert.throws(
        () =>
          command(process.execPath, ['--input-type=module', '-'], {
            cwd,
            env,
            input: verify,
            logFile: join(root, 'actual-ci-no-cleanup-negative.log'),
          }),
        /cleanup.json/
      );
      command(
        process.execPath,
        [join(cwd, 'actions/qualify-candidate-graph/qualify.mjs')],
        { cwd, env, logFile: join(root, 'actual-ci-cleanup.log') }
      );
      command(process.execPath, ['--input-type=module', '-'], {
        cwd,
        env,
        input: verify,
        logFile: join(root, 'actual-ci-verify.log'),
      });
      return {
        literalCiBodiesExecuted: true,
        noOpCleanupRejected: true,
        ownedDetachedHealthAndIdentityAsserted: true,
        actualHostedCompositeStillPending: true,
      };
    }
  );
} catch (e) {
  report.failures.push({ name: 'top-level', error: e.stack });
} finally {
  for (const dir of active)
    try {
      await stopRegistry(dir);
    } catch (e) {
      report.failures.push({
        name: 'final-cleanup',
        root: dir,
        error: e.stack,
      });
    }
  report.status = report.failures.length ? 'FAILED' : 'LOCAL_FIXTURE_QUALIFIED';
  report.helperHashes = {};
  for (const file of ['qualify.mjs', 'registry.mjs', 'action.yml'])
    report.helperHashes[file] = sha(
      await readFile(
        join(import.meta.dirname, '../actions/qualify-candidate-graph', file)
      )
    );
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      failures: report.failures.length,
      root,
    })
  );
  if (report.failures.length) process.exitCode = 1;
}
