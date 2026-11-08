import { parentPort, workerData } from 'node:worker_threads'
import { read, fstat } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { crc32, createInflateRaw } from 'node:zlib'
import yauzl from 'yauzl'
import { archiveIdentificationLimits as limits } from './identification.mjs'
import { screenScraperTarget } from './screenscraper-policy.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const { fd, consoleId, size, sha256 } = workerData
const stat = () => new Promise((resolve, reject) => fstat(fd, (error, value) => error ? reject(error) : resolve(value)))
async function bytesAt(position, length) {
  const buffer = Buffer.alloc(length)
  const n = await new Promise((resolve, reject) => read(fd, buffer, 0, length, position, (error, n) => error ? reject(error) : resolve(n)))
  if (n !== length) fail('archive_invalid')
  return buffer
}

// No path is reopened, no filesystem writes and no ownership of the parent's
// descriptor. In particular yauzl.fromFd()/close() would close that descriptor.
class BorrowedReader extends yauzl.RandomAccessReader {
  read(buffer, offset, length, position, callback) { read(fd, buffer, offset, length, position, callback) }
  _readStreamForRange(start, end) { return Readable.from(readRange(start, end), { objectMode: false, highWaterMark: 64 * 1024 }) }
}

async function* readRange(start, end) {
  for (let position = start; position < end; position += 64 * 1024) yield await bytesAt(position, Math.min(64 * 1024, end - position))
}

function safePath(name) {
  if (!name || name.length > limits.pathLength || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) fail('archive_unsupported')
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.length > limits.pathDepth || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) fail('archive_unsupported')
}

async function identify() {
  const before = await stat()
  if (!before.isFile() || before.nlink !== 1 || before.size !== size) fail('asset_mismatch')
  const outer = createHash('sha256')
  for await (const chunk of readRange(0, size)) outer.update(chunk)
  if (outer.digest('hex') !== sha256) fail('asset_mismatch')
  // Validate the ZIP32 directory envelope independently. yauzl deliberately
  // accepts some inconsistent count/size fields; identification must not.
  const tail = await bytesAt(Math.max(0, size - 65557), Math.min(size, 65557))
  let footer, footerOffset
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50 || i + 22 + tail.readUInt16LE(i + 20) !== tail.length) continue
    if (footer) fail('archive_invalid')
    footer = tail.subarray(i); footerOffset = size - tail.length + i
  }
  if (!footer) fail('archive_invalid')
  if (footer.readUInt16LE(4) || footer.readUInt16LE(6) || footer.readUInt16LE(8) !== footer.readUInt16LE(10)) fail('archive_unsupported')
  const centralBytes = footer.readUInt32LE(12), centralOffset = footer.readUInt32LE(16)
  if (centralOffset + centralBytes !== footerOffset) fail('archive_invalid')
  const zip = await yauzl.fromRandomAccessReaderPromise(new BorrowedReader(), size, { autoClose: false, strictFileNames: true, validateEntrySizes: true })
  if (!zip.entryCount || zip.entryCount > limits.entries) fail('archive_limits')
  let member, count = 0, total = 0, nextOffset = 0
  const centralStart = zip.readEntryCursor
  if (centralStart !== centralOffset) fail('archive_unsupported')
  let centralCursor = centralStart
  const names = new Set()
  // Validate ALL entries before decompressing anything. A README/second game,
  // nested archive or disc support file is not silently ignored.
  for await (const entry of zip.eachEntry()) {
    if (++count > limits.entries) fail('archive_limits')
    if ((await bytesAt(centralCursor + 34, 2)).readUInt16LE()) fail('archive_unsupported')
    centralCursor = zip.readEntryCursor
    if (centralCursor > centralOffset + centralBytes) fail('archive_invalid')
    safePath(entry.fileName)
    const name = entry.fileName.toLowerCase()
    if (names.has(name)) fail('archive_ambiguous')
    names.add(name)
    const directory = name.endsWith('/')
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if (!directory && (entry.externalFileAttributes & 0x10)) fail('archive_unsupported')
    if (mode && mode !== (directory ? 0x4000 : 0x8000)) fail('archive_unsupported')
    // Only UTF-8, data descriptor and deflate level flags. No encryption,
    // patched data, masked headers, proprietary methods or link extra fields.
    if (entry.generalPurposeBitFlag & ~0x080e || ![0, 8].includes(entry.compressionMethod)
      || entry.versionNeededToExtract > 20 || entry.extraFields.some(f => ![0x5455, 0x7875, 0x000a].includes(f.id))) fail('archive_unsupported')
    total += entry.uncompressedSize
    if (total > limits.outputBytes || entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.ratio) fail('archive_limits')
    if (directory && (entry.uncompressedSize || entry.compressedSize || entry.crc32 || entry.compressionMethod !== 0)) fail('archive_unsupported')
    const header = await zip.readLocalFileHeaderPromise(entry)
    if (!header.fileName.equals(entry.fileNameRaw) || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
      || header.compressionMethod !== entry.compressionMethod || header.versionNeededToExtract !== entry.versionNeededToExtract
      || yauzl.parseExtraFields(header.extraField).some(f => ![0x5455, 0x7875, 0x000a].includes(f.id))) fail('archive_invalid')
    if (!(entry.generalPurposeBitFlag & 8) && (header.crc32 !== entry.crc32 || header.compressedSize !== entry.compressedSize || header.uncompressedSize !== entry.uncompressedSize)) fail('archive_invalid')
    const start = entry.relativeOffsetOfLocalHeader
    let end = header.fileDataStart + entry.compressedSize
    if (entry.generalPurposeBitFlag & 8) {
      const signature = await bytesAt(end, 4)
      const signed = signature.readUInt32LE() === 0x08074b50
      const descriptor = await bytesAt(end + (signed ? 4 : 0), 12)
      if (descriptor.readUInt32LE(0) !== entry.crc32 || descriptor.readUInt32LE(4) !== entry.compressedSize || descriptor.readUInt32LE(8) !== entry.uncompressedSize) fail('archive_invalid')
      end += signed ? 16 : 12
    }
    // Reject SFX, unlisted local entries, overlaps, holes and reordered entries;
    // do not identify a different member than an engine's sequential reader.
    if (start !== nextOffset || end > centralStart) fail('archive_invalid')
    nextOffset = end
    if (directory) continue
    if (member) fail('archive_ambiguous')
    const fileName = entry.fileName.split('/').at(-1)
    if (!screenScraperTarget(consoleId, fileName).hashLookup || !entry.uncompressedSize) fail('archive_unsupported')
    member = { entry, fileName }
  }
  if (!member || count !== zip.entryCount) fail('archive_unsupported')
  if (nextOffset !== centralStart || centralCursor !== centralOffset + centralBytes) fail('archive_invalid')
  const md5 = createHash('md5'), sha1 = createHash('sha1')
  let bytes = 0, checksum = 0
  const stream = await zip.openReadStreamPromise(member.entry, member.entry.compressionMethod === 8 ? { decompress: false } : {})
  const sink = new Writable({ write(chunk, _encoding, done) {
    bytes += chunk.length
    if (bytes > limits.outputBytes || bytes > member.entry.uncompressedSize || bytes > Math.max(1, member.entry.compressedSize) * limits.ratio) return done(Object.assign(new Error('limit'), { code: 'archive_limits' }))
    md5.update(chunk); sha1.update(chunk); checksum = crc32(chunk, checksum); done()
  } })
  if (member.entry.compressionMethod === 8) {
    const inflate = createInflateRaw({ chunkSize: 64 * 1024 })
    await pipeline(stream, inflate, sink)
    if (inflate.bytesWritten !== member.entry.compressedSize) fail('archive_invalid')
  } else await pipeline(stream, sink)
  if (bytes !== member.entry.uncompressedSize || checksum !== member.entry.crc32) fail('archive_invalid')
  const after = await stat()
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) fail('asset_mismatch')
  return { fileName: member.fileName, hashes: { size: bytes, md5: md5.digest('hex'), sha1: sha1.digest('hex') },
    identification: { kind: 'zip-member', version: 1, fileName: member.fileName } }
}

try { parentPort.postMessage({ result: await identify() }) }
catch (error) {
  const code = ['archive_limits', 'archive_ambiguous', 'archive_unsupported', 'asset_mismatch'].includes(error.code) ? error.code : 'archive_invalid'
  parentPort.postMessage({ error: code })
}
