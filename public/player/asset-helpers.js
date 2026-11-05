var MainduluAssets = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/lib/player-bridge-assets.ts
  var player_bridge_assets_exports = {};
  __export(player_bridge_assets_exports, {
    engineRomInput: () => engineRomInput,
    preparedBiosBlob: () => preparedBiosBlob,
    validatePreparedAssets: () => validatePreparedAssets
  });

  // src/lib/domain.ts
  var MAX_ROM_SIZE = 768 * 1024 * 1024;
  var MAX_BIOS_SIZE = 32 * 1024 * 1024;
  function isSafeLocalUrl(value) {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !/[\u0000-\u0020]/.test(value);
  }

  // src/lib/catalog.ts
  var catalogId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

  // src/lib/asset-cache-policy.ts
  var ASSET_CHUNK_SIZE = 4 * 1024 * 1024;
  var DEFAULT_ASSET_BUDGET = 2 * 1024 * 1024 * 1024;
  var ASSET_SPACE_RESERVE = 128 * 1024 * 1024;
  var ASSET_LEASE_MS = 60 * 60 * 1e3;
  var record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var text = (v, max) => typeof v === "string" && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  function readAssetDescriptor(value) {
    if (!record(value) || value.kind !== "rom" && value.kind !== "bios" || typeof value.catalogId !== "string" || value.catalogId.length !== 36 || !catalogId.test(value.catalogId) || typeof value.sha256 !== "string" || value.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || Number(value.size) < 1 || Number(value.size) > (value.kind === "rom" ? MAX_ROM_SIZE : MAX_BIOS_SIZE) || !text(value.fileName, 255) || /[/\\]/.test(value.fileName) || value.fileName === "." || value.fileName === ".." || !text(value.consoleId, 100) || !/^[a-z0-9-]+$/.test(value.consoleId) || !text(value.label, 200)) return null;
    const prefix = value.kind === "rom" ? `/games/${value.catalogId}/rom/` : `/bios/${value.catalogId}/`;
    try {
      if (value.url !== prefix + encodeURIComponent(value.fileName)) return null;
    } catch {
      return null;
    }
    return {
      kind: value.kind,
      catalogId: value.catalogId,
      sha256: value.sha256,
      size: Number(value.size),
      fileName: value.fileName,
      url: String(value.url),
      consoleId: value.consoleId,
      label: value.label
    };
  }

  // src/lib/engine-assets.ts
  function engineAssetFileName(url) {
    if (!isSafeLocalUrl(url) || /[?#]/.test(url)) throw new Error("URL aset engine tidak valid.");
    const name = url.slice(url.lastIndexOf("/") + 1);
    let decoded;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      throw new Error("Nama aset engine tidak valid.");
    }
    if (!decoded || decoded === "." || decoded === ".." || decoded.length > 240 || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new Error("Nama aset engine tidak valid.");
    }
    return name;
  }
  function checkSize(blob, maximum) {
    if (!(blob instanceof Blob) || blob.size < 1 || blob.size > maximum) throw new Error("Ukuran aset engine tidak valid.");
  }
  function engineRomInput(file) {
    checkSize(file, MAX_ROM_SIZE);
    if (!(file instanceof File)) throw new Error("Input ROM engine harus berupa File.");
    class SessionRom extends File {
      pending;
      released = false;
      arrayBuffer() {
        if (this.released) return Promise.reject(new Error("Input ROM engine sudah dilepas."));
        return this.pending ??= super.arrayBuffer();
      }
      release() {
        this.released = true;
        this.pending = void 0;
      }
    }
    const input = new SessionRom([file], file.name, { type: file.type, lastModified: file.lastModified });
    return { file: input, release: () => input.release() };
  }
  async function preparedBiosBlob(blob, url) {
    checkSize(blob, MAX_BIOS_SIZE);
    const fileName = engineAssetFileName(url);
    if (/\.(zip|7z|rar)$/i.test(fileName)) return blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = new TextEncoder().encode(fileName);
    let crc = 4294967295;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
    }
    crc = (crc ^ 4294967295) >>> 0;
    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 67324752, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 2048, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 33639248, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 2048, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true);
    central.set(name, 46);
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 101010256, true);
    e.setUint16(8, 1, true);
    e.setUint16(10, 1, true);
    e.setUint32(12, central.length, true);
    e.setUint32(16, header.length + bytes.length, true);
    return new Blob([header, bytes, central, end], { type: "application/zip" });
  }

  // src/lib/player-bridge-assets.ts
  function validatePreparedAssets(config) {
    for (const kind of ["rom", "bios"]) {
      const value = kind === "rom" ? config.preparedRom : config.preparedBios;
      if (value === void 0) continue;
      const descriptor = readAssetDescriptor(value?.descriptor);
      if (!descriptor || descriptor.kind !== kind || descriptor.consoleId !== config.consoleId || !(value.file instanceof File) || value.file.size !== descriptor.size || value.file.name !== engineAssetFileName(descriptor.url)) {
        throw new Error("Payload aset player tidak valid atau tidak cocok dengan sesi.");
      }
      if (kind === "rom" ? config.rom !== void 0 || config.game.source !== "server" || descriptor.catalogId !== config.game.id || descriptor.url !== config.game.url || descriptor.sha256 !== config.game.sha256 || descriptor.size !== config.game.size || descriptor.consoleId !== config.game.consoleId : config.bios !== void 0 || descriptor.url !== config.biosUrl || descriptor.sha256 !== config.biosSha256) {
        throw new Error("Descriptor aset player berbeda dari sumber sesi.");
      }
    }
  }
  return __toCommonJS(player_bridge_assets_exports);
})();
