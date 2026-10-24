# Fixture pengujian save

`nes-battery.mjs` membangun ROM NES NROM-128 asli untuk pengujian, di memori, tanpa menulis berkas ke katalog publik. Source dan ROM yang dihasilkan didedikasikan ke [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/). Tidak ada ROM komersial atau BIOS pihak lain di dalam fixture ini.

- Mapper 0, 16 KiB PRG, 8 KiB CHR, dan 8 KiB battery-backed PRG RAM.
- `$6000` dan `$6001` menyimpan penanda ASCII `MD`.
- `$6002` adalah progres: naik satu saat tombol A ditekan, bukan setiap frame saat ditahan.
- CPU RAM `$00` menyimpan keadaan tombol A sebelumnya.
- Warna latar mengikuti dua bit terendah progres: hitam, merah, hijau, biru.
- Program tidak mereset progres jika penanda save valid sudah ada saat boot.

Tes browser harus membuktikan progres ditulis oleh CPU emulasi dan tetap dapat dilanjutkan setelah impor. Hanya menulis/membaca berkas virtual atau memeriksa ukurannya belum membuktikan save berhasil dimuat core.

Jalankan tes ini melalui `tests/browser/save-proof.spec.ts`. Fixture ini bukan bukti dukungan memory card PS1 atau core selain `fceumm`.
