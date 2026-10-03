import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { download, downloadParallel } from '../scripts/download.mjs';

const payload = Buffer.from('offline range fixture: ASCII and bytes \x00\xff');
const digest = createHash('sha256').update(payload).digest('hex');
let server;
let baseUrl;
let tempDir;
let rangeRequests;
let mode = 'ranges';

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'herness-download-'));
  server = http.createServer((request, response) => {
    const range = request.headers.range;
    if (range) rangeRequests.push(range);
    if (mode === 'fail') {
      response.writeHead(503).end('unavailable');
      return;
    }
    if (mode === 'ranges' && range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : payload.length - 1, payload.length - 1);
      if (start >= payload.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` }).end();
        return;
      }
      const body = payload.subarray(start, end + 1);
      response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': body.length,
      }).end(body);
      return;
    }
    response.writeHead(200, { 'Content-Length': payload.length }).end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/fixture`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

function destination(name) {
  return path.join(tempDir, name);
}

test('download writes the payload, verifies it, and skips an intact destination', async () => {
  const target = destination('basic.bin');
  rangeRequests = [];
  mode = 'ranges';
  await download(baseUrl, target, digest);
  assert.deepEqual(await readFile(target), payload);
  await download(baseUrl, target, digest);
  assert.deepEqual(rangeRequests, []);
});

test('download removes a partial file after SHA-256 mismatch', async () => {
  const target = destination('bad-hash.bin');
  await assert.rejects(download(baseUrl, target, '0'.repeat(64)), /SHA-256 mismatch/);
  await assert.rejects(stat(`${target}.part`), { code: 'ENOENT' });
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('download resumes a partial file with a Range request', async () => {
  const target = destination('resume.bin');
  const split = 11;
  await writeFile(`${target}.part`, payload.subarray(0, split));
  rangeRequests = [];
  mode = 'ranges';
  await download(baseUrl, target, digest);
  assert.deepEqual(await readFile(target), payload);
  assert.deepEqual(rangeRequests, [`bytes=${split}-`]);
});

test('download restarts from byte zero when server ignores Range', async () => {
  const target = destination('restart.bin');
  await writeFile(`${target}.part`, payload.subarray(0, 7));
  rangeRequests = [];
  mode = 'ignore-range';
  await download(baseUrl, target, digest);
  assert.deepEqual(await readFile(target), payload);
  assert.deepEqual(rangeRequests, ['bytes=7-']);
});

test('download reports unsuccessful HTTP responses', async () => {
  const target = destination('http-error.bin');
  mode = 'fail';
  await assert.rejects(download(baseUrl, target), /Download HTTP 503/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  mode = 'ranges';
});

test('downloadParallel probes and assembles verified ranges', async () => {
  const target = destination('parallel.bin');
  rangeRequests = [];
  mode = 'ranges';
  await downloadParallel(baseUrl, target, digest, 3);
  assert.deepEqual(await readFile(target), payload);
  assert.ok(rangeRequests.includes('bytes=0-0'));
  assert.equal(rangeRequests.length, 4);
});

test('downloadParallel falls back when the server does not support ranges', async () => {
  const target = destination('parallel-fallback.bin');
  rangeRequests = [];
  mode = 'ignore-range';
  await downloadParallel(baseUrl, target, digest, 3);
  assert.deepEqual(await readFile(target), payload);
  assert.deepEqual(rangeRequests, ['bytes=0-0']);
  mode = 'ranges';
});

test('downloadParallel rejects a partial file larger than the remote payload', async () => {
  const target = destination('oversized-part.bin');
  await writeFile(`${target}.part`, Buffer.alloc(payload.length + 1));
  await assert.rejects(downloadParallel(baseUrl, target, digest), /exceeds remote size/);
});

test('downloadParallel rejects a completed file with an unexpected hash', async () => {
  const target = destination('parallel-bad-hash.bin');
  await assert.rejects(downloadParallel(baseUrl, target, '0'.repeat(64), 2), /SHA-256 mismatch/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});
