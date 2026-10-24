# Riwayat perubahan maindulu

Perubahan penting per rilis didokumentasikan di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/) dengan kategori
**Ditambahkan / Diubah / Diperbaiki**; versi memakai SemVer.

Selama pengembangan, tulis eksil baru di bagian **[Belum dirilis]**;
saat rilis, promosikan isinya menjadi nomor versi dengan tanggal.

## [Belum dirilis]

### Ditambahkan

- Pemulihan akun M4 tanpa email: reset dengan kode sekali pakai, penerbitan ulang setelah verifikasi password, dan `npm run account:reset -- <username>` untuk admin lokal dengan password tersembunyi. Reset merotasi kode dan mencabut seluruh sesi secara transaksional tanpa mengubah ID akun; cloud save belum termasuk.
- Kredit/attribution di footer aplikasi dan README: maindulu dirakit oleh
  [ArdiputraCode](https://github.com/ardiputracode/maindulu), kode full assisted
  by AI; engine emulator (EmulatorJS) dan core-nya milik pembuat aslinya.

## 0.2.0 — 2026-10-23

### Ditambahkan

- Toggle **Layar lebar** di menu engine (Settings → Graphics Settings, pilihan
  Nyala/Mati dalam bahasa aplikasi): gambar 4:3 di-stretch mengisi kotak player
  16:9 tanpa menyentuh file ROM, input, atau save. Tidak berpengaruh saat kotak
  sempit (misalnya ponsel potret). Preferensi tersimpan di pengaturan maindulu
  dan diterapkan otomatis pada sesi berikutnya; kotak player ikut menjadi 16:9.
- Nomor versi tampil di halaman Pengaturan (`maindulu v…`), dibaca otomatis
  dari `package.json` saat build.

### Diubah

- Engine EmulatorJS 4.2.3 di-vendor ulang dari arsip asli terpinji SHA-256
  untuk memasang dua patch menu/hook Layar lebar. Daftar patch pada
  `third_party/emulatorjs/4.2.3/provenance.json` diperbarui; bundle dan sumber
  readable terekonstitusi secara identik dari `scripts/vendor-engine.mjs`.

### Diperbaiki

- Game gagal mulai dengan pesan "Failed to start game" ketika preferensi Layar
  lebar masih menyala dari sesi sebelumnya: pengamat ukuran kanvas lari saat
  kanvas belum tersangkut ke DOM pada urutan start engine. Regresinya tercakup
  di `tests/browser/app.spec.ts` (preferensi tersimpan + game tetap mulai).
