# Riwayat perubahan maindulu

Perubahan penting per rilis didokumentasikan di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/) dengan kategori
**Ditambahkan / Diubah / Diperbaiki**; versi memakai SemVer.

Selama pengembangan, tulis eksil baru di bagian **[Belum dirilis]**;
saat rilis, promosikan isinya menjadi nomor versi dengan tanggal.

## [Belum dirilis]

### Ditambahkan

- M8 selesai untuk penggunaan lokal: CLI `data:backup`, `data:verify`, dan `data:restore` untuk backup instalasi offline berformat folder + manifest SHA-256. Snapshot SQLite resmi dan blob aktif/cadangan M7 diverifikasi sebagai satu kumpulan; restore hanya ke folder baru, mempertahankan ID/revisi/receipt dan mencabut seluruh sesi. Lease antarproses mengecualikan maintenance dari server/reset admin tanpa menghapus dukungan koneksi bersama. Restore NES dibuktikan otomatis; pengguna mengonfirmasi progres PS1 terbaca setelah restore instalasi secara manual, bukan klaim seluruh game/card/varian. HTTPS belum diimplementasikan/diuji pengguna dan ditunda; akun jaringan belum dinyatakan siap. Panduan operasi/HTTPS/pembaruan dan matriks bukti: `doc/milestone-8-backup-operasi.md`. Tanpa enkripsi, scheduler, pruning, atau backup ROM/BIOS/aplikasi bawaan.
- M7: UI penyelesaian konflik state/progres dengan pilihan eksplisit dan cadangan versi tersisih; impor read-only save browser serta file native `.srm`/`.state`; restart player sebelum boot untuk progres server/impor. Pengelola cadangan lintas game menyediakan unduh/pulihkan/hapus, tanpa penghapusan otomatis. Metadata impor membedakan build tujuan yang dikonfirmasi dari build sumber yang tidak diketahui. NES legacy diverifikasi otomatis; pengguna mengonfirmasi tes PS1 M7 berhasil manual, dengan rincian cakupan/konfigurasi belum dicatat. Panduan dan keputusan persiapan: `doc/milestone-7-konflik-impor-save.md`.
- Migrasi SQLite versi 6: `save_backups` dan receipt `save_decisions` untuk keputusan idempoten, pemeriksaan revisi, kuota aktif+cadangan, serta pembersihan blob yang menghitung semua referensi. Bundle/fingerprint engine M6 tidak diubah.
- M6 selesai dalam cakupan terverifikasi: pemulihan progres asli game sebelum boot, pemeriksaan SRAM NES otomatis setiap 10 detik saat aktif, memcard aktif PS1, checksum/revisi, retry terbatas/idempoten, flush saat navigasi, status dan ekspor `.srm`, serta **Akun → Kelola progres game**. NES lulus otomatis; pengguna mengonfirmasi ekspor dan pemulihan PS1 dari server pada sesi/browser baru melalui Continue/Load dalam game, tanpa impor manual atau muat state M5. Seluruh game/card/varian PS1 belum diklaim. Gagal pengambilan awal menahan boot; konflik tidak ditimpa otomatis. Panduan dan hasil manual: `doc/milestone-6-progres-game.md`.
- Migrasi SQLite versi 5 untuk `game_saves` dan blob privat terpisah; paket M6 maksimal 8 MiB, kuota akun gabungan dengan state M5. Hook vendoring sinkron `EJS_mainduluBeforeBoot` memasang save setelah ekstraksi ROM tetapi sebelum `callMain`, tanpa mengubah persistence tamu.
- Save state server manual M5: tombol **Save state server** di toolbar emulator (di sebelah Import Save File) membuka overlay yang mem-pause permainan saat terbuka dan melanjutkan hanya permainan yang berjalan saat ditutup; tiga slot manual plus slot **Autosave** khusus (slot 99) dengan toggle dan interval (Nonaktif default, 30 detik, 1–15 menit) yang ditimpa otomatis saat aktif. Checksum/revisi, penyimpanan privat atomik, kuota terkonfigurasi dengan peringatan 80%, pengelola lintas game, serta unduhan cadangan dan retry eksplisit. Player akun terisolasi dari storage tamu; sinkronisasi save game/memcard tetap M6. Dukungan server dibuktikan otomatis pada NES.
- Migrasi SQLite versi 4: tabel `saves` dibangun ulang agar slot 99 (Autosave) diizinkan di CHECK constraint; data lama dipindahkan apa adanya.
- Dua patch vendoring engine baru: `togglePlaying` melaporkan transisi play/pause ke bridge (`EJS_onPlayPause` untuk jeda overlay dan gating autosave), dan `buildButtonOptions` menerima tombol bar kustom lengkap (displayName + icon + callback) yang upstream 4.2.3 menolak.
- Notifikasi autosave sederhana di pojok kanan atas player: proses simpan, konfirmasi tersimpan dari server, atau kegagalan. Notifikasi hasil hilang otomatis dan tetap tersedia saat fullscreen sesi akun.
- Pemulihan akun M4 tanpa email: reset dengan kode sekali pakai, penerbitan ulang setelah verifikasi password, dan `npm run account:reset -- <username>` untuk admin lokal dengan password tersembunyi. Reset merotasi kode dan mencabut seluruh sesi secara transaksional tanpa mengubah ID akun; cloud save belum termasuk.
- Kredit/attribution di footer aplikasi dan README: maindulu dirakit oleh
  [ArdiputraCode](https://github.com/ardiputracode/maindulu), kode full assisted
  by AI; engine emulator (EmulatorJS) dan core-nya milik pembuat aslinya.

### Diubah

- Tombol native **Import Save File** sesi akun tetap disembunyikan; gunakan wizard impor eksplisit M7 agar tidak melewati cadangan/revisi server. Ekspor native dan impor tamu tetap tersedia. Muat state server memperingatkan kemungkinan SRAM/memcard lama ikut dipulihkan dan tersinkron ulang. Dukungan PS1 di luar skenario manual yang dikonfirmasi tetap percobaan, bukan klaim seluruh card/slot/multi-disk atau tes otomatis PS1 M7.
- Menu **Save States** di dalam gerigi emulator disembunyikan untuk akun maupun tamu. Tombol native Save State/Load State untuk tamu serta nilai dan mekanisme internal **System Save interval** tidak diubah.

### Diperbaiki

- Pesan startup backend kini menyatakan kemampuan save server yang tersedia, bukan keterangan fondasi M2 yang sudah usang.
- Overlay **Save state server** tidak lagi menyusun seluruh bagian secara horizontal: satu dialog vertikal responsif, kartu slot manual/Autosave terpisah, status yang lebih jelas, serta navigasi Tab/Escape dan pemulihan fokus.
- Overlay save dan pengelola simpanan sesi akun kini tetap muncul saat fullscreen. Fullscreen mencakup pembungkus player bersama iframe, overlay, dan notifikasi; status tombol fullscreen engine mengikuti keadaan browser.

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
