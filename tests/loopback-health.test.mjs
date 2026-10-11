import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      // Only after exact ownership and SIGTERM, a reset is still inconclusive.
      if (error.code !== 'ECONNRESET') throw error;
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
      pathToFileURL(fault).href,
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
      ['--import', pathToFileURL(fault).href, fileURLToPath(helper)],
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

// These direct controls are staged only with the conditional transport fix.
// The tests-first causal controls above use only the existing helper exports.
const { registryHealth, registryResponds, stopRegistry } = await import(
  helper.href
);
const { createServer } = await import('node:http');

async function boundedProbe(pending) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(
                new Error('Probe did not settle within its test bound'),
                { code: 'TEST_OBSERVATION_DEADLINE' }
              )
            ),
          1000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withHealthServer(handler, control) {
  const requests = [],
    releases = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      connection: req.headers.connection,
      port: req.socket.remotePort,
    });
    const release = handler(req, res);
    if (typeof release === 'function') releases.push(release);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const registry = `http://127.0.0.1:${server.address().port}/`;
    return await control(registry + '__askr-health', requests, registry);
  } finally {
    for (const release of releases) release();
    server.closeAllConnections();
    if (server.listening)
      await boundedProbe(
        new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
      );
  }
}

test('Owned JSON uses a complete identity response and separate closed connections', async () => {
  await withHealthServer(
    (_, res) => res.end('{"id":"owned"}'),
    async (url, requests) => {
      assert.deepEqual(await registryHealth(url, 1000), { id: 'owned' });
      assert.equal(await registryResponds(url, 200), 200);
      assert.equal(requests.length, 2);
      assert.ok(
        requests.every(
          (r) =>
            r.method === 'GET' &&
            r.path === '/__askr-health' &&
            r.connection === 'close'
        )
      );
      assert.notEqual(requests[0].port, requests[1].port);
    }
  );
});

for (const [label, status, body] of [
  ['non-200 status', 500, '{"id":"owned"}'],
  ['redirect', 302, '{"id":"owned"}'],
  ['malformed JSON', 200, '{'],
  ['null', 200, 'null'],
  ['array', 200, '[]'],
  ['primitive', 200, '"owned"'],
  ['missing identity', 200, '{}'],
  ['empty identity', 200, '{"id":""}'],
  ['non-string identity', 200, '{"id":42}'],
  ['oversized body', 200, JSON.stringify({ id: 'x'.repeat(16 * 1024) })],
]) {
  test('Owned JSON rejects ' + label, async () => {
    await withHealthServer(
      (_, res) => {
        res.writeHead(status, {
          Location: 'https://example.invalid/never-follow',
        });
        res.end(body);
      },
      async (url, requests) => {
        await assert.rejects(
          boundedProbe(registryHealth(url, 2000)),
          (error) => {
            assert.notEqual(error.code, 'TEST_OBSERVATION_DEADLINE');
            return true;
          }
        );
        assert.equal(requests.length, 1, 'Owned probes never follow redirects');
      }
    );
  });
}

test('Owned JSON rejects a truncated complete-length body', async () => {
  await withHealthServer(
    (_, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.end('{"id":"owned"}');
    },
    async (url) => {
      await assert.rejects(boundedProbe(registryHealth(url, 2000)), (error) => {
        assert.notEqual(error.code, 'TEST_OBSERVATION_DEADLINE');
        return true;
      });
    }
  );
});

for (const trickle of [false, true]) {
  test(
    'Owned JSON enforces the absolute deadline for ' +
      (trickle ? 'trickling' : 'stalled') +
      ' bodies',
    async () => {
      await withHealthServer(
        (_, res) => {
          res.writeHead(200);
          res.flushHeaders();
          const timer = trickle
            ? setInterval(() => res.write(' '), 5)
            : undefined;
          return () => clearInterval(timer);
        },
        async (url) => {
          await assert.rejects(boundedProbe(registryHealth(url, 50)), {
            code: 'ETIMEDOUT',
          });
        }
      );
    }
  );
}

for (const [label, status, body] of [
  ['500', 500, '{}'],
  ['redirect', 302, '{}'],
  ['malformed body', 200, '{'],
  ['oversized body', 200, 'x'.repeat(20 * 1024)],
  ['stalled body', 200, null],
]) {
  test('Shutdown headers remain alive for ' + label, async () => {
    await withHealthServer(
      (_, res) => {
        res.writeHead(status, {
          Location: 'https://example.invalid/never-follow',
        });
        res.flushHeaders();
        if (body !== null) res.end(body);
      },
      async (url, requests) => {
        assert.equal(await boundedProbe(registryResponds(url, 200)), status);
        assert.equal(requests.length, 1);
      }
    );
  });
}

test('Shutdown header deadline rejects a listener that never sends headers', async () => {
  await withHealthServer(
    () => {},
    async (url) => {
      await assert.rejects(boundedProbe(registryResponds(url, 50)), {
        code: 'ETIMEDOUT',
      });
    }
  );
});

test('Invalid owned targets cannot make any request', async () => {
  await withHealthServer(
    (_, res) => res.end('{"id":"owned"}'),
    async (url, requests) => {
      const port = new URL(url).port;
      for (const target of [
        `https://127.0.0.1:${port}/__askr-health`,
        `http://localhost:${port}/__askr-health`,
        `http://127.1:${port}/__askr-health`,
        `http://user@127.0.0.1:${port}/__askr-health`,
        url + '?x=1',
        url + '#x',
        url.replace('/__askr-health', '/other'),
        'http://127.0.0.1/__askr-health',
        'http://127.0.0.1:0/__askr-health',
      ]) {
        await assert.rejects(registryHealth(target, 1000));
        await assert.rejects(registryResponds(target, 200));
      }
      assert.deepEqual(requests, []);
    }
  );
});

test('Wrong ownership identity rejects before any termination signal', async () => {
  await withHealthServer(
    (_, res) => res.end('{"id":"unrelated"}'),
    async (_, __, registry) => {
      const owner = join(root, 'wrong-identity');
      await mkdir(owner);
      await writeFile(
        join(owner, 'server.json'),
        JSON.stringify({ pid: process.pid, registry, id: 'owned' })
      );
      const original = process.kill,
        signals = [];
      process.kill = (pid, signal) => {
        assert.equal(pid, process.pid);
        signals.push(signal);
        if (signal !== 0)
          throw new Error('Test forbids terminating this process');
        return original(pid, 0);
      };
      try {
        await assert.rejects(stopRegistry(owner), /unrelated process/);
      } finally {
        process.kill = original;
      }
      assert.deepEqual(signals, [0]);
    }
  );
});
