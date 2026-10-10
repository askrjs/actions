import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOS, sha } from './qualify.mjs';

export async function createRegistry(root) {
  const id = randomUUID();
  await mkdir(root, { recursive: true });
  const send = async (request, response, status, bytes, mime, kind) => {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await appendFile(
      join(root, 'requests.jsonl'),
      JSON.stringify({
        method: request.method,
        path: request.url,
        status,
        kind,
      }) + '\n'
    );
    response.writeHead(status, {
      'content-type': mime,
      'content-length': body.length,
    });
    response.end(body);
  };
  const server = createServer((request, response) => {
    (async () => {
      if (request.method !== 'GET')
        return send(
          request,
          response,
          405,
          '{"error":"GET-only qualification fixture"}',
          'application/json',
          'rejected-write'
        );
      assert.ok(request.url.startsWith('/') && !request.url.startsWith('//'));
      const publicUrl = new URL(request.url, 'https://registry.npmjs.org');
      assert.equal(publicUrl.origin, 'https://registry.npmjs.org');
      const path = decodeURIComponent(publicUrl.pathname);
      if (path === '/__askr-health')
        return send(
          request,
          response,
          200,
          JSON.stringify({ id }),
          'application/json',
          'health'
        );
      if (path === '/__askr-candidate-graph.json')
        return send(
          request,
          response,
          200,
          await readFile(join(root, 'manifest.json')),
          'application/json',
          'inventory'
        );
      if (path.startsWith('/@askrjs/')) {
        const name = path.split('/').slice(1, 3).join('/');
        const catalog = JSON.parse(
          await readFile(join(root, 'catalog.json'), 'utf8')
        );
        if (!Object.hasOwn(REPOS, name) || !catalog[name])
          return send(
            request,
            response,
            404,
            '{"error":"Candidate unavailable; no public fallback"}',
            'application/json',
            'candidate-missing'
          );
        const entry = catalog[name],
          short = name.split('/')[1];
        if (path === `/${name}/-/${short}-0.5.0.tgz`) {
          const bytes = await readFile(entry.artifact);
          assert.equal(
            sha(bytes, 'sha512'),
            entry.archiveSha512,
            'archive changed after registration'
          );
          return send(
            request,
            response,
            200,
            bytes,
            'application/octet-stream',
            'candidate-tarball'
          );
        }
        let data;
        if (path === '/' + name)
          data = {
            name,
            'dist-tags': { latest: '0.5.0' },
            versions: { '0.5.0': entry.manifest },
          };
        else if (
          path === '/' + name + '/0.5.0' ||
          path === '/' + name + '/latest'
        )
          data = entry.manifest;
        else
          return send(
            request,
            response,
            404,
            '{"error":"Only the reviewed exact candidate exists"}',
            'application/json',
            'candidate-version-missing'
          );
        return send(
          request,
          response,
          200,
          JSON.stringify(data),
          'application/json',
          'candidate-metadata'
        );
      }
      const accept = request.headers.accept || '*/*';
      // npm's ordinary cache owns reuse; avoid retaining every platform tarball in server memory.
      const upstream = await fetch(
        'https://registry.npmjs.org' + publicUrl.pathname + publicUrl.search,
        {
          headers: { Accept: accept },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        }
      );
      const result = {
        status: upstream.status,
        mime:
          upstream.headers.get('content-type') || 'application/octet-stream',
        bytes: Buffer.from(await upstream.arrayBuffer()),
      };
      return send(
        request,
        response,
        result.status,
        result.bytes,
        result.mime,
        'public-get'
      );
    })().catch((error) => {
      console.error(error.stack || error);
      if (!response.headersSent)
        response.writeHead(502, { 'content-type': 'application/json' });
      response.end(
        '{"error":"Qualification fixture failed; inspect registry log"}'
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const info = {
    id,
    pid: process.pid,
    registry: `http://127.0.0.1:${server.address().port}/`,
    readOnly: true,
  };
  await writeFile(
    join(root, 'server.json'),
    JSON.stringify(info, null, 2) + '\n'
  );
  return { server, info };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  createRegistry(process.argv[2])
    .then(({ info }) => console.log(JSON.stringify(info)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
