# Rencana — Tombol Keluar Game dan Simpan & Keluar

Status: rencana implementasi; belum ada perubahan runtime atau pengujian fitur.

## Tujuan dan keputusan UX

Tambahkan dua tombol pada toolbar EmulatorJS, bersebelahan dengan kontrol **Enter Fullscreen / Exit Fullscreen**:

1. **Keluar game**: keluar tanpa membuat save state baru. Simpanan yang sudah ada tidak dihapus; sinkronisasi progres akun yang sudah berjalan tetap dihormati.
2. **Simpan & keluar**: jeda game, buat save state posisi persis terakhir, tunggu penyimpanan terkonfirmasi, lalu kembali ke beranda.

Makna simpan telah dikonfirmasi pengguna: **save state**, bukan hanya SRAM/memory card atau riwayat permainan. Pemulihan tetap melalui aksi **Muat** secara eksplisit, bukan auto-load saat membuka game.

| Mode sesi saat peluncuran | Tujuan save state | Cara melanjutkan |
| --- | --- | --- |
| Akun | Slot server khusus **Simpan & keluar**, usulan ID 100 | Buka game yang sama, mulai core, buka Save state server, Muat pada slot Simpan & keluar |
| Tamu | Slot browser khusus **Simpan & keluar**, key terpisah dari state native | Buka game yang sama, mulai core, pilih **Muat simpanan terakhir** |

Keputusan pengguna: gunakan **slot baru untuk akun maupun tamu**, bukan menumpang slot Autosave atau state browser native. Slot manual server 1–3, Autosave 99, serta state browser native tetap utuh. Setiap identitas game/core memiliki satu snapshot Simpan & keluar terbaru; aksi berikutnya mengganti hanya slot khusus ini. Ini bukan arsip banyak snapshot.

ID 100 adalah usulan kontrak slot server yang perlu ditetapkan konsisten di frontend, backend, dan database. Untuk tamu, gunakan key berversi yang diturunkan dari identitas engine yang sama, misalnya `getBaseFileName() + '.maindulu-exit.v1.state'`; jangan mengganti key native `getBaseFileName() + '.state'`. Tidak ada pemindahan atau penyalinan otomatis dari simpanan lama ke slot baru.

## Kondisi kode saat ini

- `public/player/player.js` mengatur `EJS_Buttons`; tombol custom sudah dipakai untuk Save state server. Konfigurasi custom saja belum menjamin letaknya tepat di samping fullscreen.
- `src/components/Player.tsx` menangani iframe, RPC state akun, pause/resume overlay, fullscreen host, serta guard sinkronisasi progres akun.
- `src/components/ServerStates.tsx` memiliki capture/upload manual, autosave slot 99, snapshot retry di memori, checksum, dan pemeriksaan revisi.
- `src/App.tsx` memakai `useBlocker` untuk konfirmasi keluar, lalu menjalankan guard progres. `leave()` saat ini hanya menavigasi ke `/`.
- Pause/resume dan RPC state pada bridge saat ini dibatasi `memorySaves`; RPC host juga dibatasi sesi akun. Dukungan tamu perlu jalur khusus yang tidak melemahkan isolasi akun.
- Fullscreen tamu pada browser yang mendukungnya memakai elemen dalam iframe; dialog React tidak otomatis terlihat di atasnya. Fullscreen akun sudah memakai `.player-shell` milik host.
- Engine native menulis state browser melalui store asynchronous; callback tombol native bukan bukti commit. Keberhasilan fitur baru tidak boleh hanya bergantung pada klik tombol Save State.

Rujukan: [M5 save state server](milestone-5-save-state-server.md), [M6 progres game](milestone-6-progres-game.md), dan [M7 konflik/impor](milestone-7-konflik-impor-save.md).

## Alur interaksi

### Keluar game

1. Kirim permintaan keluar dari toolbar ke host.
2. Gunakan jalur konfirmasi/navigasi yang sudah ada; jelaskan bahwa aksi ini tidak membuat state baru.
3. Hormati snapshot tertunda, impor/transfer, serta konflik/sinkronisasi progres akun. Tidak ada bypass penyimpanan yang belum ditangani.
4. Jika pengguna membatalkan, player tetap hidup dan keadaan pause sebelumnya dipertahankan.

Istilah **Keluar tanpa save baru** lebih tepat untuk pilihan darurat daripada **tanpa menyimpan**, karena autosave/progres sebelumnya mungkin sudah tersimpan.

### Simpan & keluar

1. Validasi sesi, game sudah dimulai, dukungan `supportsStates()`, dan tidak ada operasi eksklusif lain.
2. Tampilkan konfirmasi singkat tujuan penyimpanan dan snapshot yang akan diganti. Setelah setuju, tahan input dan jeda game; jangan bergantung pada toolbar yang otomatis hilang.
3. Hentikan penjadwalan autosave/state baru serta sinkronisasi progres baru, lalu tunggu operasi yang sedang berjalan selesai. Tangani snapshot tertunda/konflik secara eksplisit sebelum mengganti snapshot.
4. Capture state dari kondisi game yang tetap dijeda. Simpan byte snapshot ini untuk retry/cadangan, bukan capture ulang diam-diam pada setiap retry.
5. Simpan state sesuai mode sesi, tunggu konfirmasi penyimpanan.
6. Untuk akun dengan progres dalam game yang didukung, jalankan final sync dari kondisi jeda yang sama. Ini pendamping state, bukan penggantinya. Jangan tampilkan seluruh operasi berhasil bila final sync gagal.
7. Setelah semua langkah wajib berhasil dan sesi masih sama, navigasi sekali ke beranda tanpa konfirmasi atau final sync kedua.
8. Keluar dari native/pseudo-fullscreen bila perlu, lepas iframe, lalu bersihkan resource melalui lifecycle yang sudah ada.

Jika state sudah tersimpan tetapi final sync gagal, tampilkan hasil parsial dengan jelas. Retry hanya mengulang langkah yang gagal; jangan menimpa state atau menaikkan revisi tanpa kebutuhan. Opsi keluar tetap eksplisit dengan informasi progres yang belum tersinkron.

### Gagal, batal, atau core tidak mendukung

- Gagal quota, storage browser, timeout, koneksi, konflik revisi, atau akun berubah: **jangan keluar otomatis**.
- Tawarkan **Coba lagi**, **Unduh cadangan state**, **Kembali ke game**, serta **Keluar tanpa save baru** dengan konfirmasi sesuai kondisi.
- Jangan membuang snapshot retry yang sudah ada untuk capture baru tanpa persetujuan.
- Jangan menghapus state lama untuk mengatasi kuota, jangan menaikkan `expectedRevision` otomatis ketika konflik.
- Saat batal, lanjutkan hanya jika game berjalan sebelum alur dibuka. Game yang sebelumnya dijeda harus tetap dijeda.
- Core tanpa dukungan state: Simpan & keluar dinonaktifkan dan tersedia penjelasan yang bisa diakses, Keluar game tetap tersedia.
- Jika akun berubah, jangan meneruskan snapshot ke akun baru atau store tamu. Ikuti kebijakan snapshot cadangan/logout yang sudah ada; pembersihan snapshot pada pergantian akun tetap berlaku.
- Tab ditutup/crash tetap dapat kehilangan snapshot belum tersimpan. Ini bukan antrean offline atau jaminan save saat browser ditutup.

## Rancangan teknis

### 1. Toolbar dan kontrak bridge

File utama: `public/player/player.js`.

- Tambahkan dua `custom: true` button dengan label/tooltip Indonesia dan ikon keluar serta simpan-keluar.
- Setelah toolbar tersedia, posisikan node tombol relatif terhadap pasangan node fullscreen melalui referensi elemen engine; jangan mengandalkan urutan object `EJS_Buttons` atau indeks child global.
- Pemasangan harus idempoten dan tetap benar sesudah start/rebuild toolbar. Bila penanda fullscreen tidak tersedia, gunakan fallback posisi yang aman tanpa menggandakan tombol.
- Tambahkan event intent `exit-request` dengan mode terbatasi, misalnya `exit` atau `save-and-exit`. Host memvalidasi mode, origin, source-window, channel, dan session ID.
- Tambahkan status/capability agar tombol mencerminkan belum mulai, tidak didukung, dan sedang sibuk; validasi host tetap wajib walau tombol dinonaktifkan.
- Perluas pause/resume agar bisa dipakai tamu dengan bookkeeping keadaan jeda yang sama.
- Buat operasi RPC khusus penyimpanan state tamu ke browser, dengan request ID dan hasil terverifikasi. Tolak operasi ini pada sesi akun; jangan membuka akses browser store untuk mode akun.
- Operasi tamu mengambil byte state, menunggu `storage.states.put`, membaca kembali key yang sama, dan memverifikasi isi cocok. Penolakan/tidak tersedianya store harus dilaporkan sebagai gagal, bukan sukses dummy.
- Semua akses slot tamu menggunakan key khusus yang diturunkan bridge dari sesi aktif, bukan key/path arbitrer kiriman host. Tombol Save State/Load State native tetap memakai key lamanya.
- Tambahkan kontrol tamu **Muat simpanan terakhir**, dengan status tersedia/kosong dan konfirmasi sebelum mengganti permainan aktif. Jalur RPC muat membaca slot khusus, memvalidasi ukuran/format, dan memanggil load state; tidak menyalin byte ke slot native. Perintah muat bukan bukti deserialisasi sukses—buktikan pemulihan melalui tes real-engine.
- Sediakan snapshot cadangan tamu dalam batas ukuran yang sama ketika penyimpanan gagal. Jangan mengirim ROM, BIOS, token, atau identitas akun lewat kontrak baru.
- Jangan menyentuh bundle vendor secara manual. Jika perilaku store ternyata perlu patch, ubah writer vendoring beserta provenance/fingerprint dan catat perluasan scope sebelum eksekusi.

### 2. Koordinator save/exit di host

File utama: `src/components/Player.tsx`; helper/hook baru di `src/lib/` bila diperlukan.

- Gunakan state machine tunggal, misalnya `idle → confirming → preparing → capturing → saving-state → syncing-progress → exiting`, dengan cabang `error` dan pembatalan yang terkontrol.
- Kunci single-flight dengan ref/operasi ID, bukan hanya state React, agar dua klik cepat tidak membuat dua capture/upload/navigasi.
- Kunci terikat session ID dan storage owner saat peluncuran. Periksa ulang setelah setiap await; respons terlambat dari sesi lama tidak boleh menavigasi sesi baru.
- Satukan kepemilikan pause antara overlay state, transfer, dan exit agar cleanup satu overlay tidak me-resume game yang masih ditahan operasi lain.
- Pending RPC, timer, listener, dan lock harus dibersihkan saat unmount. Jangan menavigasi ketika request timeout tetapi upload mungkin masih berjalan tanpa resolusi yang jelas.
- Tampilkan pesan tujuan simpan: **Menyimpan state ke server…** atau **Menyimpan state di browser ini…**. Hindari janji pemulihan lintas perangkat untuk tamu.

### 3. Gunakan ulang pipeline state server

File utama: `src/components/ServerStates.tsx`, `src/lib/useSaveLibrary.ts`, dan helper klien di `src/lib/saves.ts`.

- Ekstrak/ekspos operasi capture/upload slot khusus Simpan & keluar melalui kontrak bertipe agar Player tidak menduplikasi checksum, metadata, batas byte, kuota, revisi, dan snapshot retry.
- Manual save, autosave, dan save-and-exit harus berbagi serialization/lock yang sama. Menghentikan interval saja tidak menghentikan upload yang sudah berjalan.
- Sukses berarti API mengonfirmasi commit dengan owner yang benar, bukan hanya byte berhasil diekspor. Refresh daftar yang gagal setelah commit tidak boleh mengubah hasil commit menjadi seolah-olah state belum tersimpan dan memicu upload ulang tanpa perlu.
- Tambahkan kartu **Simpan & keluar** terpisah dari Autosave dan slot manual pada panel server, dengan aksi Muat. Penulisan slot ini hanya melalui alur Simpan & keluar; interval autosave tetap hanya menulis slot 99.
- Gunakan endpoint save yang sudah ada dengan slot baru (usulan 100); tidak perlu endpoint baru. Perluasan kontrak backend dan migrasi database termasuk scope, lihat bagian berikut.
- Snapshot konflik dan alur transfer M7 tetap dipertahankan. Tidak ada fallback akun ke browser saat server tidak tersedia.

### 3a. Kontrak slot, migrasi, dan pengelolaan simpanan

File utama: `server/saves.mjs`, `server/database.mjs`, `src/lib/saves.ts`, `src/components/SaveLibrary.tsx`, serta jalur transfer/backup terkait.

- Perluas allowlist slot menjadi 1–3, 99, dan slot Simpan & keluar yang disepakati. Tolak angka lain; jangan sekadar melepas batas validasi.
- Tambahkan migrasi maju untuk constraint tabel `saves` yang saat ini membatasi slot 1–3/99. Pertahankan seluruh baris, ID, tombstone, revisi, metadata, index, trigger, dan relasi sesuai skema aktif; jangan mengedit migrasi historis sebagai pengganti migrasi baru.
- Snapshot slot baru tetap memakai kuota gabungan akun, batas ukuran state, checksum, ownership, optimistic revision, serta backup konflik yang sama. Tidak ada jatah bebas kuota atau penghapusan otomatis.
- Pusatkan penamaan/klasifikasi slot di frontend agar daftar, detail, retry, unduhan, penghapusan, dan konflik menampilkan **Simpan & keluar**, bukan `slot 100` atau Autosave.
- Audit impor/transfer: larang impor manual langsung ke slot khusus seperti kebijakan Autosave; ekspor/cadangan dan penghapusan eksplisit tetap tersedia. Pemulihan konflik yang sudah ada harus mengenali slot baru tanpa menimpa slot lain.
- Audit backup/restore server agar slot baru tetap terbawa dan diverifikasi. Format/parser impor yang membatasi slot wajib diselaraskan; kebutuhan perubahan versi format ditentukan dari kontrak aktual, bukan diasumsikan kompatibel.
- Uji migrasi database lama berisi slot manual/Autosave serta instalasi baru. Data lama tidak dipindahkan; slot baru awalnya kosong.

### 4. Navigasi dan fullscreen

File utama: `src/App.tsx`, `src/components/Player.tsx`, `public/player/player.js`, `src/styles.css`.

- Bedakan permintaan keluar biasa dari penyelesaian save-and-exit yang sudah disetujui. Berikan izin navigasi sekali pakai, terikat sesi dan tujuan `/`, hanya setelah operasi sukses atau keputusan keluar darurat yang eksplisit.
- Konsumsi/hapus izin saat navigasi selesai/gagal/sesi berubah. Jangan menggunakan boolean global permanen untuk mematikan blocker.
- Navigasi sidebar, tombol Kembali, browser Back, ganti game, dan tutup pintu tetap memiliki perlindungan yang sesuai; saat exit sibuk, jangan izinkan jalur lain melepas iframe di tengah capture/upload.
- Sebaiknya fullscreen tamu juga memakai `.player-shell` host agar konfirmasi, error, serta cadangan React terlihat. Ini perubahan perilaku fullscreen tamu yang memerlukan pembaruan tes native lama, bukan sekadar menambah tombol.
- Pertahankan fallback pseudo-fullscreen, Escape, perubahan orientasi opsional, fokus dialog, focus restoration, dan scroll lock. Toolbar harus tetap muat di HP dan tidak menutupi kontrol sentuh.

## Tahapan implementasi

- [ ] 1. Konfirmasi kontrak toolbar/store dari source vendor serta petakan test/helper yang dapat dipakai ulang.
- [ ] 2. Tetapkan kontrak slot baru, migrasi database, validasi API/parser, label pengelola, transfer, dan backup; ekstrak pipeline state server serta lock bersama tanpa mengubah slot manual/Autosave.
- [ ] 3. Tambahkan protokol intent, capability, pause tamu, RPC save browser ke key khusus dengan acknowledgement, serta kontrol/RPC Muat simpanan terakhir.
- [ ] 4. Tambahkan state machine host, penanganan snapshot retry/hasil parsial, dan integrasi final sync akun.
- [ ] 5. Integrasikan izin navigasi sekali pakai, guard operasi sibuk, dan fullscreen host untuk tamu.
- [ ] 6. Pasang tombol di sebelah fullscreen, dialog/status/aksesibilitas, serta bantuan cara memuat kembali.
- [ ] 7. Tambahkan regresi real-engine dan jalankan verifikasi terarah, lalu suite relevan.
- [ ] 8. Perbarui dokumentasi penggunaan, termasuk slot Simpan & keluar terpisah, migrasi/kuota, cara muat tamu, dan fullscreen tamu; catat core/varian yang benar-benar diuji.

## Rencana pengujian

### Browser real-engine

Gunakan `tests/browser/app.spec.ts`, `tests/browser/server-saves.spec.ts`, `tests/browser/server-game-saves.spec.ts`, dan helper `tests/browser/helpers/player.ts`.

- Posisi dua tombol benar-benar bersebelahan dengan fullscreen saat normal/fullscreen, termasuk tombol Exit Fullscreen yang bergantian terlihat; tidak muncul duplikat.
- Keluar biasa dapat dibatalkan, tidak menulis state baru, tidak menghapus simpanan lama, dan akhirnya melepas iframe bila disetujui.
- Tamu: gerakkan karakter demo, simpan-keluar, buka ulang ROM yang sama, pilih Muat simpanan terakhir, dan buktikan posisi RAM kembali; bukan hanya assert ada byte state. State native lama tetap dapat dimuat melalui Load State native.
- Akun: save-and-exit menulis slot khusus baru, tidak mengubah slot 1–3 atau 99, dapat dimuat setelah buka ulang, posisi RAM sesuai snapshot. Autosave sesi berikutnya tidak mengubah slot Simpan & keluar.
- Simpan & keluar kedua hanya mengganti snapshot slot khusus game/core yang sama. Identitas berbeda tidak berbagi slot; slot kosong tidak mencoba memuat native/Autosave sebagai fallback.
- Penyimpanan yang ditunda tidak melepas iframe/navigasi sebelum acknowledgement; klik ganda hanya satu operasi.
- Storage browser ditolak, kuota server habis, offline/timeout, revisi konflik, dan core tidak mendukung tidak menghasilkan sukses palsu atau keluar otomatis; save lama tetap dapat dipakai.
- Error parsial state sukses/final sync gagal menampilkan status yang tepat dan retry tidak meng-upload state lagi secara tidak perlu.
- Autosave/upload yang sedang berjalan diserialisasi; snapshot tertunda/konflik tidak dibuang otomatis.
- Batal dari game berjalan melanjutkan; batal dari game yang sudah pause tetap pause. Navigasi alternatif selama save tidak membuang iframe.
- Pergantian akun/logout di tengah await tidak menulis ke pemilik baru atau store tamu; sesi tamu yang kemudian login tetap menyimpan sebagai tamu.
- Fullscreen host/native yang relevan dan pseudo-fullscreen menampilkan dialog dengan benar; Escape dan fokus keyboard tetap bekerja. Perbarui tes tamu yang saat ini mengharapkan `.ejs_parent` sebagai fullscreen element.
- Pesan palsu dari origin/window/session/mode salah, respons terlambat, dan timeout tidak boleh memicu keluar atau menandai save berhasil.
- Jangan menyatakan semua core terverifikasi dari tes NES. Lakukan tes manual PS1/console lain yang tersedia, dokumentasikan varian serta batas kompatibilitas state.

### Unit dan perintah verifikasi

- Uji state machine, izin navigasi sekali pakai, validasi protokol, dan serialization helper bila diekstrak menjadi fungsi murni.
- Uji allowlist slot baru, kuota, konflik revisi, parser/list/pengelola, larangan impor manual ke slot khusus, dan round-trip backup/restore. Uji migrasi dari database berisi data lama serta pembuatan database baru tanpa kehilangan slot/revisi/relasi lama.
- Jalankan `npm test` dan `npm run build`.
- Jalankan suite browser terarah pada konfigurasi dev serta backend. Build ulang sebelum konfigurasi backend/production sesuai workflow repo.
- Jalankan regresi LAN/fallback dan produksi yang relevan bila fullscreen/protokol tamu berubah.
- Catat hasil aktual, core/varian, dan tes yang dilewati. Dokumen ini tidak menyatakan perintah tersebut sudah dijalankan.

## Kriteria selesai

- Dua tombol tampil di samping fullscreen dan bekerja untuk sesi akun maupun tamu.
- Simpan & keluar hanya menutup sesi setelah state benar-benar tersimpan; kegagalan tetap menyediakan jalur pemulihan/cadangan.
- State posisi terakhir terbukti bisa dimuat kembali pada engine nyata untuk kombinasi core/varian yang diuji.
- Slot Simpan & keluar terpisah untuk akun dan tamu, dapat dimuat secara eksplisit, serta tidak disentuh autosave. Tidak ada slot manual, Autosave, atau state native tamu tertimpa oleh fitur baru.
- Migrasi dan kontrak API/backup mendukung slot baru tanpa kehilangan data lama atau menghindari kuota/ownership/revisi. Tidak ada fallback akun ke browser, konfirmasi ganda setelah save sukses, atau jalur bypass guard yang tersisa.
- Autosave, final sync, konflik M7, mode pause, dan navigasi alternatif tidak berlomba melepas player atau mengganti snapshot tanpa persetujuan.
- Dokumentasi menjelaskan tempat penyimpanan, snapshot yang diganti, cara memuat, serta batas dukungan core dan ketahanan data browser.
