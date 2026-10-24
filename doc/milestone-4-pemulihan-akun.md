# M4 — Pemulihan Akun

Status: M4 selesai. Pemulihan dengan kode sekali pakai, penerbitan ulang, reset admin lokal, dan regresi mode tamu/statis telah diverifikasi dengan batasan pengujian di bawah.

Catatan: batas cloud save dan skema versi 2 di dokumen ini menggambarkan penutupan M4. [M5](milestone-5-save-state-server.md) menambahkan save state server, migrasi versi 3, dan pengujian kepemilikan save nyata setelah reset.

M4 menambahkan pemulihan akun lokal tanpa email/internet, penerbitan ulang kode, dan reset oleh pengelola yang memiliki akses sistem operasi server. **Cloud save belum tersedia**; progres emulator masih di browser sampai M5/M6.

## Lupa Password

1. Buka backend maindulu, pilih **Masuk → Lupa password?**.
2. Masukkan username, kode pemulihan, password baru, dan konfirmasinya.
3. Setelah berhasil, simpan **kode baru** yang ditampilkan sekali. Kode sebelumnya sudah tidak berlaku.
4. Tutup tampilan kode setelah menyatakan kode disimpan, lalu masuk dengan password baru. Reset tidak otomatis login.

Username mengikuti M3: ASCII 3–24 karakter, spasi tepi dipangkas dan huruf besar dianggap sama dengan huruf kecil. Password tetap 6–128 Unicode code point, maksimal 512 byte UTF-8, tanpa trim/normalisasi. Kode menerima delapan grup heksadesimal delapan karakter dipisahkan tanda hubung, atau 64 karakter heksadesimal tanpa pemisah; kapitalisasi tidak membedakan kode dan spasi tepi diabaikan. Format lain ditolak.

Kode salah, tidak cocok akun, sudah terpakai, dibatalkan, atau username tidak dikenal menghasilkan pesan yang sama: **Username atau kode pemulihan tidak sesuai.** Penutupan pendaftaran tidak menutup pemulihan akun yang sudah ada.

Jika respons terputus setelah reset, server mungkin sudah menyelesaikannya meski browser belum menerima kode baru. Coba masuk dengan password baru, lalu terbitkan ulang kode. Jangan berasumsi kode lama masih berlaku; bila tetap tidak bisa masuk, hubungi pengelola.

## Terbitkan Ulang Kode

Saat masih bisa login, buka **Akunku → Terbitkan ulang kode**, lalu masukkan password saat ini. Kode lama langsung dibatalkan setelah transaksi berhasil; password dan sesi yang sudah ada tidak berubah. Simpan kode baru sebelum menutup dialog.

Kode hanya ditampilkan sekali, tidak dapat dilihat kembali melalui endpoint sesi, dan tidak otomatis disimpan di LocalStorage/sessionStorage. Unduh berkas kode secara eksplisit atau simpan di pengelola password/lokasi privat di luar browser maindulu. Jangan membagikan kode, log terminal, atau tangkapan layarnya. Siapa pun dengan kode dan username dapat mereset akun.

Jika respons penerbitan ulang hilang, periksa sesi lalu terbitkan ulang sekali lagi dengan password saat ini. Kode yang belum sempat diterima akan dibatalkan.

## Bantuan Admin Lokal jika Kode Hilang

Tidak ada endpoint admin publik atau password admin web. Pengelola harus memiliki akses sistem operasi ke komputer server.

### Verifikasi Pemilik

Sebelum menjalankan perintah, verifikasi kepemilikan melalui cara yang sesuai dengan penggunaan server, misalnya konfirmasi langsung dengan orang yang dikenal atau kanal privat yang sudah dipercaya sebelumnya. Username saja, atau klaim dari pengunjung yang tidak dikenal, bukan bukti kepemilikan. Bila tidak dapat diverifikasi, jangan reset akun. Aplikasi tidak menyediakan bukti kepemilikan otomatis dan pengelola tidak dapat membaca password/kode lama.

### Perintah

Jalankan dari folder proyek menggunakan Node.js 24+:

```sh
npm run account:reset -- player_one
```

Gunakan folder data yang sama dengan backend. Jika bukan `data/`, contoh PowerShell:

```powershell
$env:MAIN_DULU_DATA_DIR = 'D:\maindulu-data'
npm run account:reset -- player_one
```

- Perintah menunjukkan username dan folder data yang akan digunakan. Periksa keduanya; perintah menolak database yang belum ada, bukan membuat instalasi baru tanpa sengaja.
- Masukkan password baru dan konfirmasi saat diminta. Input tidak ditampilkan, termasuk tanpa tanda bintang. **Jangan masukkan password sebagai argumen, variabel lingkungan, atau pipe.** Input/output redirect ditolak; terminal interaktif diperlukan. Ctrl+C/Escape membatalkan sebelum reset.
- Password baru dan kode baru harus diserahkan kepada pemilik melalui kanal privat yang sesuai. Kode baru dicetak sekali ke terminal setelah commit. Riwayat layar/rekaman terminal masih dapat memuat kode itu; hindari terminal yang direkam/dibagikan dan amankan riwayat layarnya.
- Semua sesi dan kode lama dibatalkan. Pemilik login dengan password baru; ID akun dan kepemilikan data tidak berubah. Pemilik dapat mengganti password lagi dan menerbitkan ulang kode sendiri.
- Disarankan menghentikan backend saat operasi administrasi dan melakukan backup konsisten terlebih dahulu. Perintah juga memakai transaksi SQLite dan pemeriksaan kredensial usang bila backend masih berjalan. Jika akun berubah selama reset, perintah gagal dan harus diulangi setelah verifikasi ulang.
- Reset akun tidak memulihkan save yang terhapus. Pemulihan berkas tetap memerlukan backup server; perintah ini bukan prosedur backup/restore.

## Kontrak dan Keamanan

| Endpoint | Input | Hasil |
| --- | --- | --- |
| `POST /api/auth/recover` | `username`, `recoveryCode`, `newPassword`, `passwordConfirmation` | `ok`, `username`, `recoveryCode` baru; cookie dibersihkan, tidak menerbitkan sesi login |
| `POST /api/auth/recovery-code` | `currentPassword` | `username`, `recoveryCode` baru; wajib sesi login dan password yang cocok, sesi dipertahankan |

Kedua endpoint memakai proteksi origin, Fetch Metadata, JSON, cookie sesi, CSRF, no-store, dan kebijakan HTTPS M3. Untuk pemulihan tanpa login, frontend meminta sesi/CSRF anonim lebih dahulu. Pengguna yang sedang login tidak boleh mereset akun lain tanpa logout.

Pemulihan menghitung hash password adaptif juga untuk username/kode yang tidak cocok, di dalam pembatas maksimal dua operasi mahal per proses. Percobaan dibatasi:

| Operasi | Batas fixed window |
| --- | --- |
| Pemulihan | 30 per 15 menit per IP; 10 per 15 menit per IP + username ternormalisasi |
| Terbitkan ulang | 30 per 15 menit per IP; 10 per 15 menit per IP + ID pengguna |

Keberhasilan/kegagalan sama-sama dihitung; 429 menyertakan Retry-After. Tidak ada penguncian akun global/permanen akibat permintaan orang lain. Limiter memakai in-memory window M3, bukan limiter terdistribusi; restart mengosongkannya. Di balik proxy, batas IP mengikuti IP proxy kecuali deployment diatur terpisah; backend tidak otomatis mempercayai forwarded headers.

Skema SQLite tetap versi 2: tidak memerlukan migrasi dari M3. Pemulihan dan reset admin melakukan UPDATE akun yang sama, mengganti hash password/kode dan DELETE seluruh sesi akun dalam satu transaksi `BEGIN IMMEDIATE`. Hash password **dan** hash kode lama diperiksa ulang saat UPDATE, sehingga operasi usang pada koneksi/proses lain tidak bisa commit setelah kredensial berubah. Tidak ada kode mentah dalam database atau request log normal. Jika pencabutan sesi gagal, seluruh perubahan di-rollback.

Penerbitan ulang memverifikasi password dan sesi, lalu memakai UPDATE bersyarat pada kedua hash lama. Permintaan bersamaan yang sama-sama membaca kode lama tidak dapat keduanya menerbitkan kode yang dianggap masih berlaku. Perubahan kode berikutnya yang sah tetap membatalkan kode sebelumnya.

ID pengguna dan waktu pembuatan tetap dipertahankan. Pengujian menggunakan record kepemilikan sentinel untuk memeriksa data terkait tidak terhapus; pengujian save server nyata baru dapat dilakukan setelah API save M5 tersedia. Player belum diubah: perilaku sinkronisasi ketika sesi dicabut menjadi cakupan M5/M6, bukan klaim cloud save M4.

## Pengujian

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:production
npm run test:e2e:backend
```

- `tests/auth.test.mjs`: kode salah/lintas akun/terpakai/batal, normalisasi, transaksi/rollback, sesi dicabut, password lama ditolak, pembatasan/CSRF, konkurensi dua koneksi SQLite, reset admin, persistensi dan log tanpa rahasia.
- `tests/admin.test.mjs`: input tersembunyi, Unicode/backspace, pembatalan/EOF/error/batas input, pemulihan raw mode, penolakan redirect/argumen password, dan eksekusi proses CLI nyata menggunakan stream terminal **simulasi** terhadap database fixture.
- `tests/account.test.mjs`: validasi respons kode sekali tampil dan snapshot identitas penerima kode.
- `tests/browser/account.spec.ts`: pemulihan lintas browser, penerbitan ulang mobile, password salah, kode lama ditolak, kode sekali tampil, sesi tetap/dicabut, storage tanpa rahasia, dan respons reset yang hilang setelah commit.

### Hasil Verifikasi

Lingkungan: Windows, Node.js 26.12.1, Microsoft Edge headless. Suite autentikasi/admin/server juga dijalankan dengan Node.js 24.22.1.

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` | 65 lulus |
| `npm run build` | Lulus |
| `npm run test:e2e` | 22 lulus; 7 tes akun dilewati pada development statis |
| `npm run test:e2e:production` | 22 lulus; 7 tes akun dilewati pada preview statis |
| `npm run test:e2e:backend` | 24 lulus, termasuk tujuh tes akun pada backend nyata |
| `tests/auth.test.mjs` + `tests/admin.test.mjs` + `tests/server.test.mjs` pada Node.js 24.22.1 | 39 lulus |
| TypeScript ketat untuk tes akun dan konfigurasi backend | Lulus |
| `npm audit --omit=dev` | Tidak ada kerentanan yang dilaporkan |

Pengujian terminal memakai simulasi stream TTY, bukan uji end-to-end ConPTY/terminal Windows native; Linux serta reverse proxy HTTPS nyata belum diverifikasi dalam milestone ini. Ini bukan klaim audit keamanan menyeluruh. Verifikasi reset terhadap save server nyata tetap menjadi penerimaan M5 karena API save belum tersedia.

Uji manual pengguna: pengguna mengonfirmasi implementasi telah dicoba dan tidak ditemukan masalah. Rincian alur serta terminal yang dicoba tidak dicatat, sehingga konfirmasi ini tidak memperluas klaim cakupan pengujian otomatis di atas.

M4 ditutup dengan hasil tersebut. M5 selanjutnya menambahkan save state manual ke server; M4 tidak mengubah engine/storage emulator.
