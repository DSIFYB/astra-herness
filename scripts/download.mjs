import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
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
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) throw new Error('downloadParallel requires an expected SHA-256 hash');
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('downloadParallel concurrency must be an integer from 1 to 32');
  expectedHash = expectedHash.toLowerCase();
  await mkdir(dirname(destination), { recursive: true });
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Existing destination is not a regular file: ${destination}`);
    if (await sha256(destination) === expectedHash) return;
    throw new Error(`Existing file has a different hash: ${destination}`);
  }
  const invalidMarker = `${destination}.segments.invalid.json`;
  if (await lstat(invalidMarker).catch(() => null)) {
    throw new Error(`Previous segmented assembly failed SHA-256 validation. Chunks were preserved; explicitly remove this destination's .segment-* files, .complete, .segments.json, and .segments.invalid.json before retrying: ${destination}`);
  }
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const range = probe.headers.get('content-range');
  await probe.body?.cancel();
  if (probe.status !== 206 || !range) {
    if (probe.status !== 200) throw new Error(`Download HTTP ${probe.status}: ${url}`);
    const sidecar = `${destination}.segments.json`;
    const segmentPrefix = `${basename(destination)}.segment-`;
    const siblings = await readdir(dirname(destination));
    const stale = siblings.filter(name => name.startsWith(segmentPrefix));
    for (const path of [`${destination}.part`, `${destination}.complete`, sidecar]) {
      if (await lstat(path).catch(() => null)) stale.push(basename(path));
    }
    if (stale.length) throw new Error(`Server does not support ranges; refusing to use segmented partials without a matching sidecar: ${stale.join(', ')}`);
    return download(url, destination, expectedHash);
  }
  const rangeMatch = /^bytes 0-0\/(\d+)$/.exec(range);
  if (!rangeMatch) throw new Error(`Invalid range probe response: ${range}`);
  const total = Number(rangeMatch[1]);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error(`Invalid remote size from range probe: ${range}`);
  const chunkSize = Math.min(64 * 1024 * 1024, total);
  const sidecar = `${destination}.segments.json`;
  const complete = `${destination}.complete`;
  const segmentPrefix = `${basename(destination)}.segment-`;
  const chunks = [];
  for (let start = 0, index = 0; start < total; start += chunkSize, index++) {
    const end = Math.min(total - 1, start + chunkSize - 1);
    chunks.push({ index, offset: start, start, end, path: `${destination}.segment-${index}` });
  }

  const manifest = {
    version: 2,
    url,
    total,
    offset: 0,
    chunkSize,
    assembly: basename(complete),
    sha256: expectedHash.toLowerCase(),
    chunks: chunks.map(({ index, offset, start, end, path }) => ({
      index, offset, start, end, path: basename(path),
    })),
  };
  const sidecarInfo = await lstat(sidecar).catch(() => null);
  const siblings = await readdir(dirname(destination));
  const existingSegments = siblings.filter(name => name.startsWith(segmentPrefix));
  const legacyPart = await lstat(`${destination}.part`).catch(() => null);
  const oldAssembly = await lstat(complete).catch(() => null);
  if (sidecarInfo) {
    if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) throw new Error(`Unsafe segmented-download sidecar: ${sidecar}`);
    let stored;
    try {
      stored = JSON.parse(await readFile(sidecar, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot resume segmented download: invalid sidecar ${sidecar}: ${error.message}`);
    }
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) {
      throw new Error(`Segmented-download sidecar does not match this URL, size, hash, or chunk layout: ${sidecar}`);
    }
    const allowedSegments = new Set(manifest.chunks.map(chunk => chunk.path));
    const unknownSegments = existingSegments.filter(name => !allowedSegments.has(name));
    if (unknownSegments.length) throw new Error(`Unexpected segmented partials; preserving them: ${unknownSegments.join(', ')}`);
    if (legacyPart) throw new Error(`Legacy partial file conflicts with segmented resume; preserving it: ${destination}.part`);
    if (oldAssembly?.isSymbolicLink() || (oldAssembly && !oldAssembly.isFile())) {
      throw new Error(`Unsafe segmented assembly file: ${complete}`);
    }
  } else {
    const stale = [...existingSegments];
    if (legacyPart) stale.push(basename(`${destination}.part`));
    if (oldAssembly) stale.push(basename(complete));
    if (stale.length) throw new Error(`Found segmented partials without a matching sidecar; preserving them: ${stale.join(', ')}`);
    const tempSidecar = `${sidecar}.tmp-${randomUUID()}`;
    await writeFile(tempSidecar, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(tempSidecar, sidecar);
  }

  let received = 0;
  for (const chunk of chunks) {
    const existing = await lstat(chunk.path).catch(() => null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Unsafe chunk partial: ${chunk.path}`);
    if (existing) {
      if (existing.size > chunk.end - chunk.start + 1) throw new Error(`Partial chunk exceeds its range: ${chunk.path}`);
      received += existing.size;
    }
  }
  let lastReport = 0;
  const downloadChunk = async chunk => {
    const expectedSize = chunk.end - chunk.start + 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const current = await lstat(chunk.path).catch(() => null);
        if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error(`Unsafe chunk partial: ${chunk.path}`);
        const partialSize = current?.size ?? 0;
        if (partialSize > expectedSize) throw new Error(`Partial chunk exceeds its range: ${chunk.path}`);
        if (partialSize === expectedSize) return;
        const start = chunk.start + partialSize;
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${chunk.end}` },
          signal: AbortSignal.timeout(30 * 60 * 1000),
        });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${chunk.end}/${total}`) {
          await response.body?.cancel();
          throw new Error(`Server rejected range bytes ${start}-${chunk.end}`);
        }
        const progress = new Transform({ transform(data, encoding, callback) {
          received += data.length;
          if (Date.now() - lastReport > 15000) {
            console.log(`${destination}: ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MiB`);
            lastReport = Date.now();
          }
          callback(null, data);
        } });
        await pipeline(Readable.fromWeb(response.body), progress,
          createWriteStream(chunk.path, { flags: partialSize ? 'a' : 'w' }));
        const finished = await lstat(chunk.path);
        if (finished.size !== expectedSize) throw new Error(`Incomplete range: ${finished.size}/${expectedSize} bytes`);
        return;
      } catch (error) {
        if (attempt === 3) throw new Error(`Chunk ${chunk.index} failed after ${attempt} attempts: ${error.message}`, { cause: error });
        await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 1000));
      }
    }
  };
  let nextChunk = 0;
  const workers = Array.from({ length: Math.min(count, chunks.length) }, async () => {
    while (nextChunk < chunks.length) {
      const chunk = chunks[nextChunk++];
      await downloadChunk(chunk);
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;

  for (const chunk of chunks) {
    const info = await lstat(chunk.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== chunk.end - chunk.start + 1) {
      throw new Error(`Chunk is not complete: ${chunk.path}`);
    }
  }
  const currentAssembly = await lstat(complete).catch(() => null);
  if (currentAssembly?.isSymbolicLink() || (currentAssembly && !currentAssembly.isFile())) {
    throw new Error(`Unsafe segmented assembly file: ${complete}`);
  }
  for (let index = 0; index < chunks.length; index++) {
    await pipeline(createReadStream(chunks[index].path), createWriteStream(complete, { flags: index ? 'a' : 'w' }));
  }
  const assembledHash = await sha256(complete);
  if (assembledHash !== expectedHash) {
    await writeFile(invalidMarker, `${JSON.stringify({ version: 1, url, total, expectedHash, assembledHash }, null, 2)}\n`, { flag: 'wx' });
    throw new Error(`SHA-256 mismatch: ${destination}; chunk contents are unverified and were preserved. Explicitly remove this destination's .segment-* files, .complete, .segments.json, and .segments.invalid.json before retrying.`);
  }
  if (await lstat(destination).catch(() => null)) throw new Error(`Destination appeared during download; refusing to overwrite: ${destination}`);
  await rename(complete, destination);
  const currentSidecar = JSON.parse(await readFile(sidecar, 'utf8'));
  if (JSON.stringify(currentSidecar) !== JSON.stringify(manifest)) {
    throw new Error(`Sidecar changed during download; preserving chunk files: ${sidecar}`);
  }
  for (const chunk of chunks) await unlink(chunk.path);
  await unlink(sidecar);
  console.log(`Downloaded and verified: ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [url, path, hash] = process.argv.slice(2);
  if (!url || !path) throw new Error('Usage: node scripts/download.mjs URL PATH [SHA256]');
  await download(url, resolve(path), hash);
}
