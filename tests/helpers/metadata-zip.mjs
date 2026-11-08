import { deflateRawSync, crc32 } from 'node:zlib'

// Synthetic ZIPs created in memory, no proprietary game/archive executable.
// Individual header overrides are for corruption/attack regression tests only.
export function metadataZip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data ?? 'abc')
    const method = e.method ?? 0, flags = e.flags ?? 0
    const compressed = e.compressed ?? (method === 8 ? deflateRawSync(data) : data)
    const checksum = e.crc ?? crc32(data), size = e.size ?? data.length
    const extra = e.extra ?? Buffer.alloc(0)
    const localName = Buffer.from(e.localName ?? e.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(flags & 8 ? 0 : checksum, 14); local.writeUInt32LE(flags & 8 ? 0 : compressed.length, 18); local.writeUInt32LE(flags & 8 ? 0 : size, 22)
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(extra.length, 28)
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0)
    if (descriptor.length) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12) }
    const record = Buffer.concat([local, localName, extra, compressed, descriptor])
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x0314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10)
    header.writeUInt32LE(checksum, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28); header.writeUInt16LE(extra.length, 30)
    header.writeUInt32LE(e.attributes ?? ((e.name.endsWith('/') ? 0x41ed : 0x81a4) * 65536), 38); header.writeUInt32LE(e.offset ?? offset, 42)
    locals.push(record); central.push(Buffer.concat([header, name, extra])); offset += record.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
