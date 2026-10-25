# M7 — Konflik dan Impor Save Lokal

Status: **M7 selesai dalam cakupan terverifikasi: NES legacy otomatis dan tes PS1 manual yang dikonfirmasi berhasil oleh pengguna.** Retensi tanpa penghapusan otomatis, impor browser/file, serta pengelolaan cadangan tersedia. Konfirmasi PS1 ini merupakan penerimaan manual M7, bukan pengangkatan hasil M6 atau klaim semua game/card/varian. Rincian skenario PS1 belum dicatat; lihat bagian hasil manual dan batas verifikasi.

Operasi instalasi terbaru: [backup/verify/restore offline M8](milestone-8-backup-operasi.md) kini tersedia. Keterangan "tetap M8" di bawah mencatat batas saat penutupan M7; cadangan konflik per akun tetap berbeda dari backup seluruh instalasi.

Keputusan persiapan yang disetujui pengguna dirangkum di bawah. Panduan ini menjadi acuan perilaku implementasi aktual dan membedakan bukti otomatis, konfirmasi manual, serta cakupan yang belum dirinci.

## Keputusan

- Impor dari **browser ini dan file `.srm` / `.state`**, hanya atas tindakan pengguna.
- Konflik save state M5 (termasuk Autosave 99) dan progres game M6 diselesaikan secara eksplisit; tidak ada merge biner atau last-write-wins.
- Cadangan konflik/impor disimpan di server, **tidak dihapus otomatis**, dan dihitung dalam kuota gabungan akun.
- Jika kuota tidak cukup untuk cadangan + versi baru, operasi ditolak tanpa mengganti save aktif.
- Memilih SRAM/memcard server atau mengimpor progres membuka ulang player, memasang progres sebelum boot, dan tetap meminta klik **Mulai bermain**.

## Upgrade dan menjalankan

1. Hentikan server. Salin **seluruh folder data privat**, termasuk SQLite/file pendamping dan direktori `saves/` serta `game-saves/`, ke lokasi cadangan di luar `public/`/`dist/`.
2. Jalankan `npm run build`, kemudian `npm start` memakai folder data yang sama.
3. Startup memigrasikan SQLite dari versi 5 ke **versi 6** secara aditif, tanpa mengganti akun, sesi, ID save, byte, atau tombstone lama.

Jangan downgrade aplikasi atau menghapus database untuk memaksa versi lama berjalan. Bundle vendor dan `public/player/builds.json` tidak diubah oleh M7; fingerprint M6 tetap dipertahankan. Prosedur backup instalasi saat server aktif dan restore terkoordinasi tetap M8.

## Menyelesaikan konflik

Konflik dapat muncul saat dua tab/perangkat memakai save/revisi yang sama, atau saat save dihapus ketika game masih berjalan. Waktu paling baru bukan bukti progres gameplay paling jauh.

### Progres game / SRAM / memcard

1. Saat status menunjukkan konflik, klik **Tinjau konflik progres** di bawah player. Kontrol ini juga tersedia melalui overlay **Save state server** agar dapat digunakan saat fullscreen.
2. Player dijeda dan penulisan progres ditahan. Snapshot terbaru diambil terpisah dari payload retry lama.
3. Klik **Tinjau versi server** untuk mengambil metadata/byte dengan verifikasi checksum. Bandingkan identitas game, ukuran, checksum, revisi, dan waktu server; unduh kandidat serta versi server bila perlu.
4. Konfirmasikan identitas/kompatibilitas, lalu pilih:
   - **Gunakan snapshot sesi ini:** versi server sebelumnya dicadangkan secara atomik, kandidat menjadi revisi baru, kemudian controller melanjutkan dari baseline baru.
   - **Gunakan versi server:** kandidat lokal dicadangkan di server tanpa mengubah revisi aktif, lalu iframe/controller diganti dengan sesi baru. Progres server diambil kembali dan dipasang sebelum boot; lanjutkan melalui Continue/Load dalam game.
   - **Batal:** tidak mengganti server; antrean yang konflik tetap tidak boleh menimpa versi lain.

Jika server berubah setelah ditinjau, keputusan ditolak dan pengguna harus meninjau ulang. Tombstone bukan slot yang bebas ditulis oleh retry lama. Jika server tidak dapat dibaca/rusak, penggantian aman ditahan; jangan menebak bahwa server kosong.

### Save state

Buka **Save state server**. Konflik slot menyediakan **Tinjau konflik state** dengan snapshot yang gagal tersimpan. Pilihan mempertahankan server mencadangkan snapshot lokal tetapi **tidak otomatis memuat state** atau mengubah permainan berjalan. Setelah penyelesaian, gunakan **Muat** bila memang ingin melanjutkan dari slot tersebut.

Konflik Autosave 99 juga dapat ditinjau, dan snapshot pending menahan autosave berikutnya. Retry tidak menaikkan revisi sendiri. Memuat state lama dapat mengembalikan SRAM/memcard lama; peringatan M5 tetap berlaku.

## Mengimpor save

### Persiapan

- Login **sebelum** membuka game. Pilih ROM/BIOS yang sesuai, lalu mulai core untuk mengetahui key runtime dan build tujuan aktual.
- Untuk ROM lokal, hash isi/arsip harus sesuai. Judul atau nama file saja bukan bukti region/revisi/ROM yang sama. Tidak ada penggabungan identitas ROM lokal dan katalog server.
- Ekspor salinan sumber terlebih dahulu jika progres penting. Tutup sesi tamu lain yang masih menulis storage browser.
- UI impor berada pada **player game yang dipilih**, bukan pemindai global semua save/riwayat atau formulir akun tanpa game aktif.

### Progres `.srm` / browser

1. Pilih **Impor progres** di bawah player atau pada overlay **Save state server**.
2. Aplikasi menjeda dan terlebih dahulu berupaya menyinkronkan progres sesi saat ini. Jika gagal/konflik, selesaikan masalah itu dahulu; jangan membuang progres aktif demi impor.
3. Pilih file native **`.srm`**, atau klik **Baca save browser ini**.
4. Klik **Tinjau versi server**. Jika target sudah terisi, versi yang diganti akan menjadi cadangan; pemakaian kuota mencakup kedua versi.
5. Konfirmasikan identitas dan kompatibilitas tujuan, lalu **Konfirmasi impor ke server**.
6. Setelah server mengonfirmasi commit, player dibuka ulang. Klik **Mulai bermain**, lalu periksa Continue/Load dalam game. File lokal dan record browser asal **tidak dihapus**, termasuk setelah impor sukses.

### Save state `.state` / browser

1. Buka **Save state server → Impor state**.
2. Pilih slot manual **1–3**, lalu file **`.state`** atau **Baca save browser ini**. Impor tidak menargetkan Autosave 99.
3. Tinjau server dan konfirmasi. Impor menyimpan snapshot ke slot, **tidak otomatis memuatnya**.
4. Pilih **Muat** pada slot tujuan dan periksa progres. Engine tidak menyediakan konfirmasi deserialisasi yang andal; respons RPC bukan bukti gameplay berhasil pulih.

### Identitas dan kompatibilitas yang belum diketahui

State browser lama dan file mentah tidak selalu membawa hash ROM atau fingerprint engine/core asal. Karena itu:

- UI menyatakan **build sumber tidak diketahui**. Metadata build yang direkam adalah **build tujuan yang dikonfirmasi pengguna**, bukan metadata asal yang dibuat-buat.
- Metadata impor membawa `provenance: { source: 'browser' | 'file', sourceBuild: 'unknown', confirmedForTarget: true }`.
- Perubahan engine/core/runtime berikutnya tetap mengikuti pemeriksaan kompatibilitas M5/M6. Tidak ada bypass kompatibilitas global.
- Tidak ada parser menyeluruh SRAM/state/memcard atau konversi antarcore/region. Ekstensi, signature, ukuran dan persetujuan pengguna bukan jaminan bahwa semua file akan terbaca game.
- Implementasi saat ini tidak menyediakan sesi percobaan terpisah sebelum commit impor. Periksa hasil pada sesi game, gunakan cadangan server untuk pemulihan bila salah, dan jangan menghapus sumber.

## Batas storage browser dan format

| Sumber/jenis | Kontrak |
| --- | --- |
| State browser | IndexedDB `EmulatorJS-states`, store `states`, key `<getBaseFileName()>.state` dari runtime game |
| Progres browser | IDBFS database `/data/saves`, store `FILE_DATA`, record `contents` (`Int8Array` pada runtime NES yang diuji) pada path native core yang dilaporkan runtime; dinormalisasi sebagai byte unsigned tanpa mengubah bit/sumber |
| File state | `.state`, header `RASTATE`, 32 byte–64 MiB pada player; batas server M5 tetap berlaku |
| File progres NES | Native `.srm` nonkosong pada adapter fceumm; ukuran paket dan batas M6 tetap berlaku |
| File progres PS1 | Native `.srm` memcard aktif **128 KiB**; bukan `.mcr`, `.gme`, shared-card, semua slot/card, atau multi-disk |

Pembaca hanya mengambil key kandidat yang ditentukan game; transaksi IndexedDB **readonly**, tanpa memakai helper upstream yang membuka `readwrite`. Pembukaan database yang belum ada dibatalkan pada `upgradeneeded`; sumber tidak dibuat/dimigrasikan oleh wizard. Storage yang ditolak/rusak bukan save kosong.

Hanya browser/profil dan **origin yang sama** yang dapat dibaca. HTTP vs HTTPS, hostname/IP/localhost, dan port yang berbeda mempunyai storage terpisah. Untuk origin lama, ekspor file lewat sesi tamu pada origin itu, lalu impor file di origin akun. Jangan mengirim atau mengunggah semua storage browser. Save tamu tidak memiliki kepemilikan akun yang dapat dibuktikan; pengguna bertanggung jawab memilih sumber pada perangkat bersama.

## Cadangan dan kuota

**Akun → Kelola cadangan konflik/impor** menyediakan daftar lintas game, unduhan native `.srm`/`.state`, peninjauan pemulihan, dan hapus berkonfirmasi. Gunakan setelah menangani/keluar dari player.

- Pemulihan membuat revisi aktif baru dan mencadangkan versi aktif yang digantinya. Cadangan asal tetap ada. Untuk progres, buka ulang player; untuk state, pilih Muat secara terpisah.
- Default kuota akun tetap **256 MiB**, gabungan **state aktif + progres aktif + cadangan**. Variabel `MAIN_DULU_SAVE_QUOTA_BYTES` tetap berlaku; tidak ada konfigurasi TTL/pruning otomatis.
- Untuk penggantian berbackup, ukuran lama tetap terhitung. Hasil akhir umumnya pemakaian sebelumnya **+ ukuran kandidat**, bukan rumus selisih overwrite rutin M5/M6.
- Tidak ada penghapusan otomatis ketika kuota penuh. Hapus cadangan pilihan sendiri atau naikkan kuota melalui pengelola, lalu retry keputusan yang sama.
- Menghapus save aktif tidak menghapus cadangan; menghapus cadangan tidak menghapus save aktif. Tombstone tetap menjaga revisi aktif.
- Batas metadata: 5.000 cadangan dan 20.000 receipt keputusan per akun. Receipt tidak dipangkas otomatis agar request lama tidak dapat diulang sebagai keputusan baru. Batas receipt memerlukan bantuan pengelola/pengembangan lanjutan, bukan penghapusan save diam-diam.
- Cadangan dibuat pada aksi konflik, penggantian lewat impor, serta pemulihan; **bukan setiap tick 10 detik, autosave state, atau semua overwrite rutin**.
- Cadangan di disk server yang sama bukan perlindungan dari kerusakan komputer. M8 tetap perlu backup konsisten di lokasi lain.

## Jaringan dan sesi

Keputusan menggunakan ID operasi, payload, dan expected revision tetap. Bila respons hilang sesudah commit, **Coba keputusan yang sama lagi** mengembalikan receipt tanpa menambah cadangan atau revisi. ID yang sama dengan payload berbeda ditolak. Jangan refresh untuk membuat keputusan baru ketika hasil lama belum pasti.

Saat hasil belum pasti, dialog mempertahankan kandidat di memori dan menahan penulisan otomatis. Gangguan sementara pemeriksaan status akun juga mempertahankan dialog/kandidat/ID retry, tetapi menonaktifkan penulisan sampai akun yang sama kembali terkonfirmasi. Unduh kandidat; jika kuota penuh, kelola lewat tab lain lalu retry. Refresh/crash/tutup tab dapat menghilangkan kandidat dan ID retry; tidak ada antrean offline persisten. Periksa versi aktif dan daftar cadangan sebelum melakukan keputusan baru.

Logout/pencabutan sesi/pergantian akun membatalkan klien dan menutup UI/iframe yang tidak lagi berhak. Kandidat akun lama tidak diteruskan ke akun baru. Mode akun tidak dialihkan diam-diam ke storage tamu.

## API dan penyimpanan

M5/M6 `PUT /api/saves/` dan `PUT /api/game-saves/` menerima field opsional pada `X-Save-Metadata`:

```json
{ "operation": { "id": "UUID", "action": "replace", "reason": "conflict" } }
```

- `action`: `replace` atau `preserve` (cadangkan kandidat lokal, jangan ganti aktif).
- `reason`: `conflict`, `import`, `restore`; `preserve` hanya untuk konflik.
- Respons `{ save, backupId, usage }`; `save` dapat null pada preserve tanpa target, atau tombstone. Penulisan rutin tanpa operation tetap memakai kontrak revisi M5/M6.
- Expected revision, owner/sesi, kuota, pencadangan, penggantian metadata dan receipt diperiksa/ditulis dalam transaksi `BEGIN IMMEDIATE` yang sama.
- Cadangan versi server diverifikasi ukuran/checksum sebelum penggantian; file rusak bukan cadangan sukses.

| Endpoint cadangan | Kontrak |
| --- | --- |
| `GET /api/save-backups/` | `{ backups, usage }` milik akun; metadata tanpa byte |
| `GET /api/save-backups/:id` | Byte + `X-Save-Metadata`; validasi checksum |
| `POST /api/save-backups/:id/delete` | JSON `{ checksum }`, ownership/CSRF/konfirmasi pada UI |

Pemulihan memakai pembacaan cadangan lalu PUT eksplisit `reason: 'restore'` terhadap identitas/revisi tujuan yang ditinjau. Tidak ada path file dari klien.

Skema versi 6 menambahkan `save_backups` dan `save_decisions`. Blob cadangan tetap memakai namespace `saves/` atau `game-saves/` yang privat, dengan referensi immutable. Garbage collection/penghapusan terkoordinasi menghitung referensi aktif **dan** cadangan agar restart tidak menyapu versi yang dipertahankan. Kegagalan transaksi tidak mengganti save aktif; temp/rename/fsync mengikuti M5/M6. Uji rollback bukan simulasi pemadaman listrik.

Autentikasi, assertion `X-Save-User`, CSRF, Origin/Fetch Metadata, limiter, batas body, checksum, UUID/path guard, dan no-store dipertahankan. HTTP dilakukan host React, bukan iframe; konfigurasi/pesan player tidak membawa password/cookie/token/ID akun. ROM/BIOS tidak termasuk payload impor/sinkronisasi jalur aplikasi; byte opaque tetap bukan pemindai konten biner menyeluruh.

## Verifikasi

Perintah: `npm test`, `npm run build`, `node --check public/player/player.js`, `npm run test:e2e:backend`, `npm run test:e2e`, `npm run test:e2e:production`. Build mendahului suite production/backend.

`tests/save-transfer.test.mjs` menambahkan kontrak kedua jenis save: backup/replay/restore/restart, preserve kandidat/tombstone, dua koneksi berebut revisi, kuota gabungan, rollback, sumber rusak, ownership/CSRF, provenance dan format impor. Tes browser M7 berada di `server-saves.spec.ts` serta `server-game-saves.spec.ts`, memakai engine NES nyata dan persistence tamu asli.

Lingkungan: Windows, Node.js 26.12.1, Microsoft Edge headless. Jalur backend terkait juga dijalankan pada Node.js 24.22.1.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 100 lulus |
| `npm run build` | Lulus |
| Sintaks `public/player/player.js` | Lulus |
| TypeScript ketat kedua suite browser save | Lulus |
| M7 + M5/M6/server unit/integrasi pada Node.js 24.22.1 | 44 lulus |
| Browser backend penuh | 45 lulus; sebelum guard tambahan status akun sementara, yang diperiksa ulang melalui M7 terarah |
| M7 terarah pada revisi akhir | 5 lulus; termasuk retensi kandidat/ID retry ketika pemeriksaan akun gagal sementara, mobile/fullscreen, dan keutuhan sumber browser |
| Development statis | 22 lulus; 28 skenario akun/server sengaja dilewati |
| Production statis pada build akhir | 22 lulus; 28 skenario akun/server sengaja dilewati |
| PS1 M7 manual pengguna | Pengguna mengonfirmasi tes manual berhasil; rincian game/konfigurasi/skenario belum dicatat, bukan tes otomatis |

Pada regresi awal, pengujian membuktikan IDBFS menyimpan SRAM sebagai `Int8Array`; pembaca M7 diperbaiki untuk mempertahankan bit/offset tanpa menulis sumber. Muat state perlu memberi core kesempatan berjalan setelah overlay ditutup sebelum pemeriksaan RAM. Helper start menggunakan input keyboard yang didukung bridge setelah berpindah tab/restart. Pada regresi penuh berikutnya seluruh skenario M7 lulus, dengan satu regresi M5 gagal hanya karena label pesan retry konflik berubah; label diperjelas lalu suite penuh diulang dan 45 lulus. Guard tambahan untuk mempertahankan kandidat/receipt saat pemeriksaan akun gagal sementara diuji pada lima tes M7 akhir, termasuk mobile/fullscreen; unit dan production statis juga diulang pada revisi akhir. Angka tabel hanya berasal dari eksekusi selesai, bukan percobaan gagal. Suite statis sengaja melewati tes akun/server dan bukan bukti API akun berfungsi di deployment statis.

PS1 M7 diterima berdasarkan konfirmasi manual pengguna di bawah, bukan suite otomatis. NES normal/core lain, memcard seluruh card/slot, reverse proxy HTTPS nyata, pemadaman listrik, dan sesi percobaan impor sebelum commit tidak dinyatakan terbukti oleh hasil tersebut.

### Hasil manual PS1 M7 — pengguna

- [x] Pengguna mengonfirmasi bahwa tes manual PS1 setelah implementasi M7 sudah berhasil dan siap di-commit.

Konfirmasi ini merupakan bukti manual pengguna untuk penutupan M7, bukan hasil tes otomatis PS1. Judul/region game, format/sumber ROM, browser/perangkat, BIOS/HLE, varian core, card/slot, serta langkah impor/konflik/pemulihan yang dicoba belum dirinci. Jangan menganggap seluruh item checklist berikut sudah dijalankan atau memperluas hasil menjadi dukungan semua game, card, slot, varian, atau multi-disk.

Saat menyiapkan commit penutupan setelah konfirmasi tersebut, `npm test` diperiksa ulang (100 lulus) dan `npm run build` lulus. Tidak ada perubahan kode runtime pada pembaruan dokumentasi ini; suite browser pada tabel berasal dari verifikasi implementasi M7 sebelumnya dan tidak diulang untuk perubahan dokumentasi saja.

### Checklist tambahan / pencatatan cakupan PS1

Item belum dicentang di bawah adalah rincian/pengujian tambahan yang belum dikonfirmasi satu per satu, bukan pembatalan hasil manual berhasil di atas.

- [ ] Cadangkan sumber; catat game/region, format/sumber ROM, browser/perangkat, BIOS/HLE, core/varian dan card/slot.
- [ ] Impor native `.srm` aktif yang diketahui cocok, lalu Continue/Load di sesi baru tanpa state M5; sumber tetap ada.
- [ ] Buat konflik dua sesi, uji memilih lokal dan server, lalu periksa versi yang kalah pada pengelola cadangan.
- [ ] Pulihkan cadangan ke revisi baru; buka ulang dan periksa progres asli game.
- [ ] Uji kuota/jaringan gagal dan retry tanpa menggandakan cadangan atau menimpa revisi lain.

Jangan kirim ROM/BIOS/password/kode pemulihan. Konfirmasi M7 manual berasal langsung dari pengguna setelah implementasi; hasil M6 tetap bukti terpisah dan tidak otomatis memperluas cakupan impor M7, seluruh card/slot atau varian PS1.
