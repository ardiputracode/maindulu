# M6 — Sinkronisasi Progres Game

Catatan M7: [penyelesaian konflik, impor browser/file, dan cadangan](milestone-7-konflik-impor-save.md) kini mempunyai implementasi terpisah; kuota menghitung cadangan dan SQLite terbaru versi 6. Pernyataan impor/retensi belum tersedia di bawah mencatat kondisi penutupan M6, bukan status fitur terbaru. Verifikasi manual PS1 M6 tidak otomatis membuktikan M7.

Status: **M6 selesai untuk cakupan terverifikasi: SRAM NES otomatis dan memcard aktif PS1 yang diuji manual pengguna.** Pengguna mengonfirmasi ekspor serta pemulihan progres server pada sesi/browser baru tanpa impor manual atau muat state M5. Bukti PS1 ini berasal dari tes M6, bukan pengangkatan hasil M1. Dukungan di luar skenario PS1 tersebut tetap percobaan; UI penyelesaian konflik/impor tetap M7 dan backup server terkoordinasi tetap M8.

## Cara menggunakan

**Memperbarui M5:** hentikan proses server dahulu, salin seluruh folder data privat (SQLite beserta file pendamping yang ada dan direktori save) ke lokasi cadangan di luar `public/`/`dist/`, kemudian build dan jalankan versi baru. Startup memigrasikan skema ke versi 5. Ini backup saat server berhenti; penyalinan file saat server aktif bukan prosedur backup konsisten. Jangan menghapus database agar versi lama bisa berjalan.

```sh
npm run build
npm start
```

1. Buka `http://localhost:7777`, login, lalu buka ROM dan BIOS yang sesuai. Dev/preview/Nginx statis tidak menyediakan API akun.
2. Untuk core yang dicakup, aplikasi mengambil progres server **sebelum engine boleh mulai**. Jika pengambilan gagal, tidak ada fallback diam-diam ke game baru: gunakan **Coba ambil progres lagi** atau kembali.
3. Klik **Mulai bermain**. Lanjutkan melalui menu Continue/Load asli game, bukan tombol Muat save state M5.
4. Simpan melalui menu asli game. Setiap 10 detik saat game aktif, tab terlihat, dan overlay state tertutup, aplikasi melakukan flush, membandingkan checksum, lalu mengunggah hanya perubahan. **Sinkronkan progres sekarang** juga bekerja saat game dijeda.
5. Periksa status **Sinkronisasi progres game** di bawah player. Konfirmasi server hanya berlaku untuk snapshot yang benar-benar diunggah, bukan perubahan yang belum diperiksa. Game tanpa battery/save dapat menampilkan **Game belum menghasilkan berkas save**; itu bukan kesalahan.
6. Saat keluar melalui navigasi aplikasi, game dijeda dan progres terbaru diupayakan sinkron. Bila gagal, batalkan keluar untuk retry/unduh cadangan, atau pilih keluar tanpa sinkronisasi secara eksplisit.
7. Di browser/perangkat lain, login ke **server dan origin yang sama**, pilih ROM yang sama, lalu gunakan Continue/Load dalam game. ROM lokal tetap harus dipilih ulang. Nama berkas boleh berbeda, tetapi hash isi/arsip harus sama. Repack ZIP, ROM region/revisi berbeda, atau disk berbeda menghasilkan identitas lokal berbeda.

Mode akun dipilih saat peluncuran; login pada tab lain tidak mengubah sesi tamu yang sudah berjalan. Favorit, riwayat, dan preferensi tetap lokal. ROM/BIOS tidak termasuk payload sinkronisasi.

## Dukungan dan batasan

| Core | Layout | Status |
| --- | --- | --- |
| NES / fceumm legacy | `nes-sram-v1`, satu SRAM `.srm` aktif | Round-trip engine nyata otomatis |
| NES / fceumm normal | Layout sama | Diaktifkan, varian belum diuji terpisah |
| PS1 / pcsx_rearmed | `ps1-active-memcard-v1`, satu `.srm` aktif yang diekspor core | Ekspor dan pemulihan server lintas sesi/browser lulus manual pengguna; bukan bukti semua game/card/varian |
| SNES, GB/GBC, GBA, Mega Drive | Belum ada adapter | Tidak disinkronkan; sesi akun tetap MEMFS sementara |

Satu berkas aktif **bukan klaim seluruh card/slot PS1**. Jika core membuat berkas tambahan pada direktori save, ekspor M6 ditolak daripada mengunggah paket yang diam-diam tidak lengkap. Sinkronisasi dihentikan juga jika path aktual sesudah boot berbeda dari adapter. Gunakan ekspor native emulator dan simpan cadangan. Pergantian disk, shared memcard lintas game, penamaan arsip bertingkat, semua konfigurasi HLE/BIOS, perangkat mobile, serta varian normal/legacy PS1 belum terverifikasi.

Save dalam game berbeda dari save state. Memuat state lama dapat ikut mengembalikan SRAM/memcard lama; perubahan itu dapat tersinkron sebagai progres terbaru. Konfirmasi muat state memperingatkan risiko tersebut. Unduh cadangan progres sebelum memuat state lama. Tidak ada penggabungan biner, retensi versi otomatis, atau jaminan state menggantikan seluruh memcard.

## Pemulihan sebelum boot dan isolasi

```text
Host React: daftar progres → unduh paket → verifikasi SHA-256/envelope
→ configure iframe dengan byte native, tanpa cookie/token/ID akun
→ pengguna menekan Mulai bermain
→ filesystem akun MEMFS → ekstraksi ROM/BIOS selesai
→ EJS_mainduluBeforeBoot: validasi build/layout, pasang .srm
→ Module.callMain: game membaca progres
→ validasi path aktual → izinkan sinkronisasi
```

Hook sinkron baru berada tepat sebelum `callMain`, setelah `fileName` final tersedia. Tidak ada fetch asinkron dalam event `saveDatabaseLoaded`. Adapter memetakan stem nama runtime ke `/data/saves/FCEUmm/<stem>.srm` atau `/data/saves/PCSX-ReARMed/<stem>.srm`; tidak menganggap nama save state sama dengan nama memcard. Path ini tidak dikirim sebagai path penyimpanan server.

Core build, versi engine, fingerprint runtime, varian, dan layout harus sesuai sebelum pemulihan otomatis. Perbedaan ditahan sebelum boot; tidak ada opsi paksa atau overwrite otomatis. Unduh save lama dari **Kelola progres game** sebelum memperbarui engine. Migrasi kompatibilitas belum tersedia. Perubahan patch JavaScript engine mengubah fingerprint runtime dan dapat memblokir pemulihan save M6 lama; jangan menghapus progres untuk melewati pemeriksaan tanpa cadangan.

Patch dibuat melalui `scripts/vendor-engine.mjs` dari arsip 4.2.3 terpin, dengan sumber readable, bundle, fingerprint, dan provenance diperbarui. Persistence IDBFS/state tamu tidak berubah. Sesi akun tidak membaca atau menulis IDBFS tamu. Tombol **Import Save File** native disembunyikan pada sesi akun agar tidak melewati alur impor eksplisit M7; ekspor native tetap tersedia.

## Antrean dan kegagalan

- Satu operasi capture/upload pada satu waktu. Snapshot tanpa perubahan tidak diunggah lagi.
- Kegagalan sementara (jaringan, 429, 5xx) mendapat maksimal tiga retry otomatis. Backoff minimum 2/4/8 detik diperiksa pada tick 10 detik berikutnya saat game aktif. Sesudah batas ini pengguna harus retry eksplisit.
- Pending write yang hasilnya belum pasti dipertahankan dengan byte dan revisi asal. Snapshot terbaru disimpan terpisah di memori; pending lama diselesaikan dahulu. Exit drain dibatasi agar tidak looping tanpa batas.
- Replay payload+metadata persis pada revisi berikutnya mengembalikan konfirmasi yang sama, tanpa menambah revisi. Data berbeda dengan revisi usang menghasilkan `REVISION_CONFLICT` dan menghentikan antrean; retry tidak mengambil revisi baru untuk menimpa data tab lain.
- Batas ukuran, kuota, dan error permanen tidak di-retry otomatis. Save server lama tetap utuh. Save yang tidak ada/rusak saat pengambilan bukan bukti slot kosong.
- `null` dari core bukan penghapusan. Paket harus mempunyai komponen nonkosong; byte seluruhnya nol tidak otomatis ditolak karena bisa sah bagi suatu core.
- Logout/pencabutan sesi menghentikan antrean. Snapshot yang sudah diambil masih dapat diunduh selama akun belum berganti. Pergantian akun membersihkan snapshot lama, membatalkan koneksi, dan menghapus iframe; tidak ada rebinding antrean.
- Ketika status akun tidak dapat dipastikan, pemeriksaan otomatis ditahan, bukan dialihkan ke tamu. Server tetap memeriksa sesi dan pemilik pada setiap request.
- Tidak ada antrean offline persisten: crash/refresh/tutup tab dapat menghilangkan perubahan belum tersinkron. `beforeunload` hanya peringatan, bukan jalur upload yang dijanjikan.

## Kuota, pengelola, dan cadangan

Default satu paket M6 **8 MiB**, termasuk envelope; kuota gabungan M5+M6 **256 MiB per akun**. Penggantian dihitung dari selisih byte, dicek lagi di transaksi SQLite yang sama pada kedua jalur. Tidak ada penghapusan otomatis demi ruang.

| Variabel | Default | Batas |
| --- | --- | --- |
| `MAIN_DULU_GAME_SAVE_MAX_BYTES` | `8388608` | 1024–8388608 |
| `MAIN_DULU_SAVE_QUOTA_BYTES` | `268435456` | 1024–17179869184; bersama save state |

Setel sebelum `npm start`; restart diperlukan. Menurunkan kuota tidak menghapus data lama. Batas payload aplikasi absolut 8 MiB; pengelola menghitung ukuran paket, bukan hanya byte `.srm`. Batas 5.000 identitas progres termasuk tombstone per akun; terpisah dari batas identitas slot M5.

**Akun → Kelola progres game** menyediakan daftar lintas game, penggunaan gabungan, unduh, dan hapus berkonfirmasi. Gunakan setelah keluar dari player. Menghapus progres game yang masih berjalan di tab/perangkat lain akan menyebabkan upload lama konflik, bukan menghidupkan ulang save diam-diam.

**Unduh cadangan progres** pada player mengambil save aktif terbaru jika sesi masih tersedia; setelah sesi berakhir hanya snapshot yang sudah ada di host yang dapat diunduh. Hasil unduh berupa `.srm` native, **bukan `.state`**, ROM, BIOS, atau backup server lengkap. Catat ROM/hash, core, versi engine, dan layout yang sesuai. Impor cadangan/file/browser ke akun belum tersedia (M7). Ekspor native emulator tetap jalur alternatif jika adapter menolak layout.

## Kontrak API dan penyimpanan

Semua endpoint membutuhkan sesi dan `X-Save-User` yang cocok dengan pemilik sesi. Mutasi membutuhkan CSRF dan pemeriksaan origin/Fetch Metadata. Assertion header bukan pemilih akun. Respons no-store; tidak ada CORS lintas origin.

| Endpoint | Hasil / input |
| --- | --- |
| `GET /api/game-saves/` | `{ saves, usage }`, termasuk tombstone; tanpa byte |
| `GET /api/game-saves/:id` | Octet-stream + `X-Save-Metadata` JSON URI-encoded |
| `PUT /api/game-saves/` | Octet-stream; metadata URI-encoded: identitas game/console/core/title, `expectedRevision`, checksum SHA-256, metadata build + `layout`; hasil `{ save, usage }` |
| `POST /api/game-saves/:id/delete` | JSON `{ expectedRevision }`; tombstone menaikkan revisi |

Envelope `MDGSAVE1`: magic 8 byte, panjang header uint32 little-endian, JSON UTF-8 maksimal 4096 byte, lalu byte komponen. Header versi 1: `{ formatVersion, layout, files: [{ key: 'sram', size }] }`. Saat ini tepat satu komponen; bukan ZIP dan tidak mengekstrak path klien. Manifest/ukuran/checksum divalidasi server; isi native tetap opaque, bukan parser menyeluruh format memcard atau pemindai ROM.

Migrasi SQLite **versi 5** menambah `game_saves` tanpa mengganti akun/sesi/slot M5. Blob privat berada di `<dataDir>/game-saves/<uuid>.bin`, berbeda dari `<dataDir>/saves/`. Temp write/fsync/rename, commit metadata+revisi+kuota, penghapusan blob lama setelah commit, serta startup orphan cleanup ber-write-lock mengikuti pola M5. Pengujian rollback bukan simulasi pemadaman listrik. Cadangkan database beserta kedua direktori save; prosedur terkoordinasi tetap M8. Jangan downgrade aplikasi atau menghapus database untuk memaksa versi lama berjalan.

Limiter M6: 120 request/menit per akun, 30 upload/menit, maksimal dua upload diproses per proses pada jalur M6. Limiter M5 terpisah. Backend membutuhkan checkout sumber, termasuk modul format bersama `src/lib/game-save-format.ts`; Docker Nginx tetap deployment statis, bukan backend akun.

## Verifikasi otomatis

```sh
npm test
npm run build
node --check public/player/player.js
npm run test:e2e:backend
npm run test:e2e
npm run test:e2e:production
```

`tests/game-saves.test.mjs` menguji envelope, persistensi/restart, otorisasi, CSRF, kuota gabungan dua koneksi, revisi/tombstone/replay, rollback/orphan/rusak, serta controller retry/deduplikasi. Paket PS1 sintetis hanya bukti kontrak API, **bukan bukti gameplay/memcard PS1**.

`tests/browser/server-game-saves.spec.ts` memakai fixture NES asli yang CPU-nya menulis battery RAM. Round-trip memeriksa byte progres dan input sesudah pemulihan melalui boot, tanpa impor filesystem test-only. Skenario mencakup restart server+browser context baru, nama ROM berubah, gagal pengambilan awal/retry, upload gagal/cadangan, navigasi flush, konflik dua tab, isolasi SRAM tamu, logout dan pergantian akun. Byte upload yang diamati berupa envelope SRAM, bukan ROM/BIOS.

Hasil historis M1/M5 tidak otomatis menjadi hasil M6. Pada regresi awal M6, 38 tes backend lulus (termasuk enam skenario M6 saat itu dan seluruh regresi M5). Sesudah penambahan tes kompatibilitas/startup ROM server serta perbaikan diagnostik abort engine, delapan tes M6 terarah lulus. Pesan pemulihan spesifik kini dipertahankan meski abort engine menghasilkan error generik susulan.

Lingkungan verifikasi: Windows, Node.js 26.12.1, Microsoft Edge headless; jalur backend M6 juga diperiksa pada Node.js 24.22.1.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 88 lulus |
| `npm run build` | Lulus |
| `node --check public/player/player.js` | Lulus |
| Development statis | 22 lulus; 23 tes akun/server sengaja dilewati |
| Production statis | 22 lulus; 23 tes akun/server sengaja dilewati |
| Backend penuh pada verifikasi awal | 38 lulus; lihat lingkup/waktu pengujian di atas |
| M6 terarah | 8 lulus; termasuk penolakan versi sebelum boot dan SRAM ROM server |
| M6 + server unit/integrasi di Node.js 24.22.1 | 23 lulus |
| TypeScript ketat tes browser M6 | Lulus |
| Vendoring ulang arsip terpin | Enam output sumber/bundle/loader/fingerprint/provenance identik byte demi byte |

Suite frontend statis tidak membuktikan API akun; tes server sengaja dilewati pada mode tersebut. Pengujian PS1 biner sintetis tidak memperluas matriks dukungan gameplay. Reverse proxy HTTPS nyata, pemadaman listrik, dan seluruh variasi PS1 belum diverifikasi.

## Checklist tes manual PS1 — pengguna

### Hasil penerimaan M6

Pada 25 Oktober 2026, pengguna mengonfirmasi:

- [x] Ekspor save PS1 berhasil.
- [x] Setelah progres dikonfirmasi server, pengguna membuka sesi/browser baru, login dengan akun yang sama, dan membuka ROM yang sama.
- [x] Progres berhasil dipulihkan melalui **Continue/Load dalam game**, tanpa impor file manual dan tanpa memuat save state M5.

Hasil tersebut memenuhi penerimaan round-trip memcard aktif PS1 untuk penutupan M6 dalam cakupan yang diuji. Ini konfirmasi manual pengguna, bukan tes otomatis PS1. Judul/region game, format dan sumber ROM, browser/perangkat, BIOS/HLE, varian core, serta card/slot spesifik belum dicatat; jangan menebak detail tersebut atau menggeneralisasi hasilnya. Restart server untuk PS1, seluruh card/slot, pengulangan perubahan progres, gangguan jaringan pada PS1, dan multi-disk tetap memerlukan pengujian tambahan. Restart server, kegagalan jaringan, serta isolasi akun/tamu sudah diuji otomatis pada NES sebagaimana bagian verifikasi di atas.

Pada penutupan, `npm test` diperiksa ulang (88 lulus) dan `npm run build` lulus sesudah pembaruan dokumentasi serta teks status PS1. Suite browser pada tabel di atas berasal dari verifikasi implementasi M6 sebelumnya; tidak diulang hanya untuk perubahan teks penutupan ini.

### Checklist pengujian tambahan / perluasan cakupan

Gunakan ROM/BIOS yang kamu berhak pakai, hanya dari perangkat sendiri; jangan commit atau tempatkan firmware/ROM proprietari di aset publik untuk pengujian. Cadangkan progres yang penting terlebih dahulu. Jangan memakai satu-satunya salinan memcard.

- [ ] Catat browser/perangkat, game/region, format (CHD/ZIP CUE+BIN/PBP), sumber lokal/server, BIOS/HLE, varian core, serta konfigurasi slot/card yang dipakai.
- [ ] Login akun A; buka PS1 dan buat save melalui menu game. Pastikan status bukan error path/layout/berkas tambahan. Tunggu konfirmasi atau tekan **Sinkronkan progres sekarang**.
- [ ] Unduh cadangan `.srm`. Periksa bahwa **Akun → Kelola progres game** mencatat game/core, ukuran masuk akal, dan revisi; save state M5 tidak diperlukan untuk tes ini.
- [ ] Tutup sesi, restart server, login A lewat browser/profil baru tanpa data situs lama. Pilih ROM yang sama. Gunakan Continue/Load di game: progres yang benar harus tersedia **tanpa Muat state M5 atau impor manual**.
- [ ] Buat perubahan progres, simpan lagi, sinkronkan, dan ulangi pemulihan. Ini membuktikan core benar-benar membaca/mengubah memcard, bukan hanya berkas FS terlihat ada.
- [ ] Uji beberapa slot save game serta kedua card bila game/core menawarkannya. Catat persis mana yang pulih. Jika ada berkas tambahan/error, ekspor native dan laporkan; jangan menyatakan cakupan semua card.
- [ ] Jika memakai ROM lokal, ulangi dengan nama berkas berbeda tetapi isi sama. Jika perlu dukungan CHD server/ZIP, uji terpisah; jangan menganggap hasil satu format berlaku untuk yang lain.
- [ ] Putuskan koneksi sesudah game aktif; simpan di game. Pastikan UI gagal/belum tersinkron, cadangan dapat diunduh, lalu pulihkan koneksi dan retry. Jangan menutup tab selama belum dikonfirmasi.
- [ ] Batalkan navigasi keluar ketika sinkronisasi gagal, unduh cadangan, lalu retry. Pengguna harus dapat kembali bermain/menangani save tanpa overwrite server diam-diam.
- [ ] Buka akun B pada profil terpisah untuk game yang sama: progres A tidak muncul. Kembali ke A: progres A tetap ada. Uji juga save tamu agar tidak diimpor/ditimpa oleh akun.
- [ ] Catat keterbatasan multi-disk/shared-card secara terpisah; identitas ROM lokal berbeda tidak otomatis berbagi memcard.

Laporkan hasil tambahan beserta pesan error, varian core, format ROM, ukuran/revisi progres, dan slot/card yang dicoba. **Jangan kirim ROM/BIOS/password/kode pemulihan.** Checklist tambahan ini mempertahankan batas bukti dan membantu perluasan dukungan; bukan klaim bahwa seluruh item telah lulus. M6 telah ditutup untuk cakupan terverifikasi di atas, sementara dukungan PS1 di luar skenario pengguna tetap percobaan.
