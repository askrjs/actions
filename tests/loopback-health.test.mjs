import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = new URL(
  '../actions/qualify-candidate-graph/qualify.mjs',
  import.meta.url
);
const root = join(
  process.env.RUNNER_TEMP || tmpdir(),
  'askr-candidate-tests',
  'loopback-' + process.pid + '-' + Date.now()
);
await mkdir(root, { recursive: true });
const fault = join(root, 'native-qos-fault.mjs');
await writeFile(
  fault,
  `import { Socket } from 'node:net';
import assert from 'node:assert/strict';
process.stderr.write('Owned child native QoS original surface: ' + typeof Socket.prototype.setTypeOfService + '\\n');
assert.equal(typeof Socket.prototype.setTypeOfService, 'function', 'The fault control requires the actual native QoS surface');
process.stderr.write('Owned child native QoS fault armed\\n');
Socket.prototype.setTypeOfService = function () {
  const error = new Error('setTypeOfService EINVAL');
  Object.assign(error, { code: 'EINVAL', errno: -22, syscall: 'setTypeOfService' });
  throw error;
};
`
);

await writeFile(
  join(root, 'native-qos-fault-source.log'),
  await readFile(fault)
);

// This independent test oracle also cleans an old helper's crashed-child server.
// It deliberately does not import either proposed health-probe export.
function observedHealth(registry, body) {
  const url = new URL(registry + '__askr-health');
  assert.equal(url.href, `http://127.0.0.1:${url.port}/__askr-health`);
  return new Promise((resolve, reject) => {
    let req,
      res,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res?.destroy();
      req?.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Owned test health deadline')),
      2000
    );
    req = request(
      url,
      { method: 'GET', agent: false, headers: { Connection: 'close' } },
      (response) => {
        res = response;
        response.on('error', (error) => finish(error));
        if (!body) return finish(null, response.statusCode);
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024)
            return finish(new Error('Owned test health body limit'));
          chunks.push(chunk);
        });
        response.on('aborted', () =>
          finish(new Error('Owned test health body aborted'))
        );
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            finish(error);
          }
        });
      }
    );
    req.on('error', (error) => finish(error));
    req.end();
  });
}

async function cleanupOwned(serverRoot) {
  let info;
  try {
    info = JSON.parse(await readFile(join(serverRoot, 'server.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert.ok(Number.isSafeInteger(info.pid) && info.pid > 0);
  try {
    process.kill(info.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  try {
    const health = await observedHealth(info.registry, true);
    assert.equal(
      health.id,
      info.id,
      'Test cleanup must prove exact owned registry identity'
    );
    process.kill(info.pid);
  } catch (error) {
    // A completed literal cleanup has already stopped its owned listener.
    if (error.code !== 'ECONNREFUSED') throw error;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await observedHealth(info.registry, false);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Owned test registry still answers after cleanup');
}

async function runChild(label, args, env) {
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  await writeFile(join(root, label + '.stdout.log'), result.stdout || '');
  await writeFile(join(root, label + '.stderr.log'), result.stderr || '');
  await writeFile(
    join(root, label + '.json'),
    JSON.stringify(
      {
        executable: process.execPath,
        args,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        node: process.version,
        platform: process.platform,
      },
      null,
      2
    ) + '\n'
  );
  return result;
}

function starter(serverRoot) {
  return `import {startRegistry} from ${JSON.stringify(helper.href)};
console.log(JSON.stringify(await startRegistry(${JSON.stringify(serverRoot)})));`;
}

test('Actual registry startup survives a child-local native QoS error boundary', async () => {
  const serverRoot = join(root, 'startup-owner');
  let result;
  try {
    result = await runChild('fault-startup', [
      '--import',
      fault,
      '--input-type=module',
      '-e',
      starter(serverRoot),
    ]);
  } finally {
    await cleanupOwned(serverRoot);
  }
  assert.match(result.stderr, /Owned child native QoS fault armed/);
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  const retained = JSON.parse(
    await readFile(join(serverRoot, 'server.json'), 'utf8')
  );
  assert.equal(info.id, retained.id);
  assert.equal(info.pid, retained.pid);
  await assert.rejects(observedHealth(info.registry, false), {
    code: 'ECONNREFUSED',
  });
});

test('Actual literal cleanup survives a child-local native QoS error boundary', async () => {
  const digest = 'a'.repeat(64),
    runner = join(root, 'literal');
  const serverRoot = join(runner, 'askr-0.5-candidate-' + digest);
  let result, info;
  try {
    const started = await runChild('literal-start', [
      '--input-type=module',
      '-e',
      starter(serverRoot),
    ]);
    assert.equal(started.status, 0, started.stderr);
    info = JSON.parse(started.stdout);
    assert.equal((await observedHealth(info.registry, true)).id, info.id);
    const env = {
      PHASE: 'cleanup',
      MANIFEST_REF: 'b'.repeat(40),
      MANIFEST_SHA256: digest,
      RUNNER_TEMP: runner,
      GITHUB_ENV: join(runner, 'github-env'),
    };
    result = await runChild(
      'fault-literal-cleanup',
      ['--import', fault, fileURLToPath(helper)],
      env
    );
    assert.match(result.stderr, /Owned child native QoS fault armed/);
    assert.equal(result.status, 0, result.stderr);
    const cleanup = JSON.parse(
      await readFile(join(serverRoot, 'cleanup.json'), 'utf8')
    );
    assert.deepEqual(cleanup, { stopped: true, pid: info.pid, id: info.id });
    await assert.rejects(observedHealth(info.registry, false), {
      code: 'ECONNREFUSED',
    });
    assert.ok(
      (await readFile(env.GITHUB_ENV, 'utf8')).endsWith(
        'NPM_CONFIG_AUDIT=true\n'
      )
    );
  } finally {
    await cleanupOwned(serverRoot);
  }
});
