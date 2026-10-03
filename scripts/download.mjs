import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function download(url, destination, expectedHash) {
  await mkdir(dirname(destination), { recursive: true });
  const existing = await stat(destination).catch(() => null);
  if (existing && (!expectedHash || await sha256(destination) === expectedHash)) {
    console.log(`Already present: ${destination}`);
    return;
  }
  const part = `${destination}.part`;
  const offset = (await stat(part).catch(() => null))?.size ?? 0;
  const response = await fetch(url, {
    headers: offset ? { Range: `bytes=${offset}-` } : {},
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`);
  const resume = offset > 0 && response.status === 206;
  let received = resume ? offset : 0;
  const total = received + Number(response.headers.get('content-length') ?? 0);
  let lastReport = 0;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (Date.now() - lastReport > 15000) {
        console.log(`${destination}: ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MiB`);
        lastReport = Date.now();
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress,
    createWriteStream(part, { flags: resume ? 'a' : 'w' }));
  if (expectedHash && await sha256(part) !== expectedHash) {
    await unlink(part);
    throw new Error(`SHA-256 mismatch: ${destination}`);
  }
  await rename(part, destination);
  console.log(`${expectedHash ? 'Downloaded and verified' : 'Downloaded'}: ${destination}`);
}

export async function downloadParallel(url, destination, expectedHash, count = 8) {
  await mkdir(dirname(destination), { recursive: true });
  if (await stat(destination).catch(() => null)) {
    if (await sha256(destination) === expectedHash) return;
    throw new Error(`Existing file has a different hash: ${destination}`);
  }
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const range = probe.headers.get('content-range');
  await probe.body.cancel();
  if (probe.status !== 206 || !range) return download(url, destination, expectedHash);
  const total = Number(range.split('/')[1]);
  const part = `${destination}.part`;
  const offset = (await stat(part).catch(() => null))?.size ?? 0;
  if (offset > total) throw new Error(`Partial download exceeds remote size: ${destination}`);
  const chunkSize = Math.ceil((total - offset) / count);
  const chunks = [];
  for (let index = 0; index < count && offset + index * chunkSize < total; index++) {
    const start = offset + index * chunkSize;
    chunks.push({ start, end: Math.min(total - 1, start + chunkSize - 1),
      path: `${destination}.segment-${index}` });
  }
  let received = offset;
  let lastReport = 0;
  await Promise.all(chunks.map(async (chunk) => {
    const response = await fetch(url, { headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
      signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (response.status !== 206 || response.headers.get('content-range') !==
        `bytes ${chunk.start}-${chunk.end}/${total}`) throw new Error('Server rejected download range');
    const progress = new Transform({ transform(data, encoding, callback) {
      received += data.length;
      if (Date.now() - lastReport > 15000) {
        console.log(`${destination}: ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MiB`);
        lastReport = Date.now();
      }
      callback(null, data);
    } });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(chunk.path));
    if ((await stat(chunk.path)).size !== chunk.end - chunk.start + 1) throw new Error('Incomplete range');
  }));
  const complete = `${destination}.complete`;
  const inputs = [...(offset ? [part] : []), ...chunks.map(chunk => chunk.path)];
  for (let index = 0; index < inputs.length; index++) {
    await pipeline(createReadStream(inputs[index]), createWriteStream(complete, { flags: index ? 'a' : 'w' }));
  }
  if (await sha256(complete) !== expectedHash) throw new Error(`SHA-256 mismatch: ${destination}`);
  await rename(complete, destination);
  for (const path of inputs) await unlink(path);
  console.log(`Downloaded and verified: ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [url, path, hash] = process.argv.slice(2);
  if (!url || !path) throw new Error('Usage: node scripts/download.mjs URL PATH [SHA256]');
  await download(url, resolve(path), hash);
}
