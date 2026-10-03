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
const chunkSize = 64 * 1024 * 1024;
const largePayload = Buffer.alloc(chunkSize + 4096, 0x71);
const largeDigest = createHash('sha256').update(largePayload).digest('hex');
let server;
let baseUrl;
let tempDir;
let rangeRequests;
let mode = 'ranges';
let largeMode = 'normal';
let largeRangeRequests = [];
let activeLargeResponses = 0;
let interruptedChunkAttempts = 0;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'herness-download-'));
  server = http.createServer((request, response) => {
    const range = request.headers.range;
    if (new URL(request.url, 'http://localhost').pathname === '/large') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), largePayload.length - 1);
      largeRangeRequests.push({ start, end });
      const sendRange = (rangeStart = start, rangeEnd = end, contentRangeStart = rangeStart) => {
        const body = largePayload.subarray(rangeStart, rangeEnd + 1);
        response.writeHead(206, {
          'Content-Range': `bytes ${contentRangeStart}-${rangeEnd}/${largePayload.length}`,
          'Content-Length': body.length,
        }).end(body);
      };
      if (start === 0 && end === 0) {
        sendRange();
        return;
      }
      activeLargeResponses++;
      response.once('close', () => { activeLargeResponses--; });
      if (largeMode === 'interrupt-second' && start >= chunkSize && interruptedChunkAttempts < 3) {
        interruptedChunkAttempts++;
        const body = largePayload.subarray(start, end + 1);
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${largePayload.length}`,
          'Content-Length': body.length,
        });
        response.write(body.subarray(0, 1024));
        setTimeout(() => response.destroy(), 30);
        return;
      }
      if (largeMode === 'range-error' && start === 0) {
        response.writeHead(206, {
          'Content-Range': `bytes 1-${end}/${largePayload.length}`,
          'Content-Length': 0,
        }).end();
        return;
      }
      const delay = largeMode === 'range-error' ? 200 : 0;
      setTimeout(() => sendRange(), delay);
      return;
    }
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
  assert.equal(rangeRequests.length, 2);
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

test('downloadParallel refuses to mix a legacy partial with the segmented format', async () => {
  const target = destination('legacy-partial.bin');
  await writeFile(`${target}.part`, Buffer.alloc(payload.length + 1));
  await assert.rejects(downloadParallel(baseUrl, target, digest), /partials without a matching sidecar/);
  assert.equal((await stat(`${target}.part`)).size, payload.length + 1);
});

test('downloadParallel rejects a completed file with an unexpected hash', async () => {
  const target = destination('parallel-bad-hash.bin');
  await assert.rejects(downloadParallel(baseUrl, target, '0'.repeat(64), 2), /SHA-256 mismatch/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('downloadParallel resumes an interrupted chunk and preserves an already completed chunk', async () => {
  const target = destination('large-resume.bin');
  largeMode = 'interrupt-second';
  interruptedChunkAttempts = 0;
  largeRangeRequests = [];
  await assert.rejects(downloadParallel(`${baseUrl.replace('/fixture', '')}/large`, target, largeDigest, 1), /failed after 3 attempts/);

  const chunk0 = await stat(`${target}.segment-0`);
  const chunk1 = await stat(`${target}.segment-1`);
  assert.equal(chunk0.size, chunkSize);
  assert.equal(chunk1.size, 3 * 1024);
  assert.ok(await stat(`${target}.segments.json`));

  largeMode = 'normal';
  largeRangeRequests = [];
  await downloadParallel(`${baseUrl.replace('/fixture', '')}/large`, target, largeDigest, 1);
  assert.deepEqual(await readFile(target), largePayload);
  assert.deepEqual(largeRangeRequests, [
    { start: 0, end: 0 },
    { start: chunkSize + 3 * 1024, end: largePayload.length - 1 },
  ]);
  await assert.rejects(stat(`${target}.segment-0`), { code: 'ENOENT' });
  await assert.rejects(stat(`${target}.segment-1`), { code: 'ENOENT' });
  await assert.rejects(stat(`${target}.segments.json`), { code: 'ENOENT' });
});

test('downloadParallel waits for all active chunk writers after a worker error', async () => {
  const target = destination('parallel-worker-error.bin');
  largeMode = 'range-error';
  activeLargeResponses = 0;
  largeRangeRequests = [];
  await assert.rejects(
    downloadParallel(`${baseUrl.replace('/fixture', '')}/large`, target, largeDigest, 2),
    /failed after 3 attempts/,
  );
  assert.equal(activeLargeResponses, 0);
  assert.equal((await stat(`${target}.segment-1`)).size, 4096);
  const stableSize = (await stat(`${target}.segment-1`)).size;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await stat(`${target}.segment-1`)).size, stableSize);
  assert.equal(largeRangeRequests.filter(range => range.start === chunkSize).length, 1);
});

test('downloadParallel refuses mismatched sidecar metadata without deleting partials', async () => {
  const target = destination('mismatched-sidecar.bin');
  const sidecar = {
    version: 2,
    url: `${baseUrl}?different=true`,
    total: payload.length,
    offset: 0,
    chunkSize: payload.length,
    sha256: digest,
    chunks: [{ index: 0, offset: 0, start: 0, end: payload.length - 1, path: path.basename(target) + '.segment-0' }],
  };
  await writeFile(`${target}.segments.json`, JSON.stringify(sidecar));
  await writeFile(`${target}.segment-0`, payload.subarray(0, 4));
  await assert.rejects(downloadParallel(baseUrl, target, digest), /does not match this URL, size, hash, or chunk layout/);
  assert.deepEqual(await readFile(`${target}.segment-0`), payload.subarray(0, 4));
  assert.deepEqual(JSON.parse(await readFile(`${target}.segments.json`, 'utf8')), sidecar);
});

test('downloadParallel SHA failure leaves no final destination', async () => {
  const target = destination('segmented-bad-hash.bin');
  await assert.rejects(downloadParallel(baseUrl, target, '0'.repeat(64), 2), /SHA-256 mismatch/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert.ok((await stat(`${target}.segments.json`)).isFile());
  assert.ok((await stat(`${target}.segment-0`)).isFile());
});
