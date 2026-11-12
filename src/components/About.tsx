import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

const repository = 'https://github.com/ardiputracode/maindulu'

function CreditLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14} /></a>
}

export default function About() {
  return <div className="about-page">
    <div className="page-heading"><div><span className="eyebrow">DI BALIK JEDA KECIL</span><h1>Kenangan besar, berkat banyak tangan.</h1><p>maindulu adalah ruang kecil untuk kembali menikmati game yang kamu ingat. Pilih permainan, siapkan waktu senggang, dan biarkan jempol mengingat jalannya.</p></div></div>
    <section className="guide-panel about-intro" aria-label="Tentang maindulu">
      <p>Dirakit oleh <strong>ArdiputraCode</strong> dengan bantuan AI sepanjang proses pengembangan. Di baliknya, ada banyak karya dan komunitas yang membuat ruang main ini mungkin.</p>
      <div className="legal-links"><CreditLink href={repository}>Kode sumber</CreditLink><CreditLink href={`${repository}/issues`}>Ada yang kurang pas? Laporkan</CreditLink></div>
    </section>
    <div className="about-grid">
      <section className="guide-panel">
        <span className="eyebrow">INSPIRASI</span><h2>Berawal dari inspirasi.</h2>
        <p><strong>RomM</strong> menjadi salah satu inspirasi besar dalam pembuatan maindulu, terutama cara menghadirkan koleksi game sebagai ruang yang nyaman untuk dijelajahi.</p>
        <p>Terima kasih kepada tim dan komunitas RomM atas karya serta inspirasinya. maindulu adalah proyek independen dan tidak berafiliasi dengan RomM.</p>
        <div className="legal-links"><CreditLink href="https://github.com/rommapp/romm">Kenalan dengan RomM</CreditLink></div>
      </section>
      <section className="guide-panel">
        <span className="eyebrow">MESIN EMULASI</span><h2>Yang menghidupkan permainan.</h2>
        <p><strong>EmulatorJS v4.2.3</strong> membawa mesin emulasi ke browser, bersama core emulator yang dikembangkan oleh pembuat dan komunitasnya masing-masing.</p>
        <p>maindulu merangkai pengalaman bermainnya. Kerja besar di balik emulasinya tetap milik para pengembang tersebut.</p>
        <p>EmulatorJS menggunakan lisensi GPL-3.0-or-later. Setiap core memiliki lisensinya sendiri, yang dapat dilihat melalui menu About pada emulator.</p>
        <div className="legal-links"><CreditLink href="https://github.com/EmulatorJS/EmulatorJS">EmulatorJS</CreditLink><CreditLink href="/vendor/emulatorjs/4.2.3/LICENSE">Lisensi engine</CreditLink><CreditLink href={`${repository}/tree/main/third_party/emulatorjs`}>Sumber & patch</CreditLink></div>
      </section>
      <section className="guide-panel">
        <span className="eyebrow">METADATA & COVER</span><h2>Biar koleksi punya cerita.</h2>
        <p><strong>ScreenScraper</strong> membantu melengkapi koleksi dengan informasi dan cover game saat fitur metadata server diaktifkan.</p>
        <p>Terima kasih kepada tim dan para kontributornya yang merawat informasi tentang begitu banyak permainan.</p>
        <p>Metadata dan gambar tetap mengikuti hak pemilik serta ketentuan penyedianya. Tersedianya informasi game bukan berarti ada izin untuk membagikan ROM-nya.</p>
        <div className="legal-links"><CreditLink href="https://www.screenscraper.fr/">Kunjungi ScreenScraper</CreditLink></div>
      </section>
      <section className="guide-panel">
        <span className="eyebrow">ALAT BANTU</span><h2>Bantuan kecil di balik layar.</h2>
        <p><strong>rom-converto</strong>, karya <strong>DevYukine</strong>, membantu membaca serial disc PS1 dari berkas CHD agar pencarian metadata punya petunjuk yang lebih tepat.</p>
        <p>maindulu menggunakan rom-converto v0.24.0, berlisensi MIT.</p>
        <div className="legal-links"><CreditLink href="https://github.com/DevYukine/rom-converto">Lihat rom-converto</CreditLink><CreditLink href="/assets/rom-converto-LICENSE.txt">Lisensi rom-converto</CreditLink></div>
      </section>
    </div>
    <section className="guide-panel about-components">
      <span className="eyebrow">KOMPONEN & ASET</span><h2>Detail kecil, ikut berjasa.</h2>
      <p>Antarmuka dan backend ini juga dibangun dengan pustaka, ikon, font, dan alat dari berbagai pembuat. Masing-masing tetap mengikuti lisensi dan hak pemiliknya.</p>
      <ul className="about-dependencies">
        <li><CreditLink href="https://github.com/facebook/react/blob/main/LICENSE">React · MIT</CreditLink></li>
        <li><CreditLink href="https://github.com/remix-run/react-router/blob/main/LICENSE.md">React Router · MIT</CreditLink></li>
        <li><CreditLink href="https://lucide.dev/license">Ikon Lucide · ISC</CreditLink></li>
        <li><CreditLink href="/assets/Manrope-OFL.txt">Font Manrope · SIL OFL 1.1</CreditLink></li>
        <li><CreditLink href="https://github.com/fastify/fastify/blob/main/LICENSE">Fastify · MIT</CreditLink></li>
        <li><CreditLink href="https://github.com/paulmillr/noble-hashes/blob/main/LICENSE">@noble/hashes · MIT</CreditLink></li>
        <li><CreditLink href="https://github.com/lovell/sharp/blob/main/LICENSE">sharp · Apache-2.0</CreditLink></li>
        <li><CreditLink href="https://github.com/thejoshwolfe/yauzl/blob/master/LICENSE">yauzl · MIT</CreditLink></li>
        <li><CreditLink href="/games/LICENSE.txt">Demo Jalan Pulang · CC0</CreditLink></li>
      </ul>
      <div className="legal-links"><CreditLink href={`${repository}/blob/main/package.json`}>Daftar dependensi proyek</CreditLink></div>
    </section>
    <section className="guide-panel legal-panel">
      <span className="eyebrow">HAK & PRIVASI</span><h2>Main dengan nyaman. Pakai dengan hak.</h2>
      <p>Gunakan ROM dan BIOS yang berhak kamu gunakan. Game, gambar, nama konsol, dan merek yang disebut tetap milik pemegang hak masing-masing. Penyebutannya tidak menunjukkan afiliasi atau dukungan resmi.</p>
      <p>Saat pencarian metadata server diaktifkan, nama berkas, ukuran, hash, sistem, atau serial disc dapat dikirim ke ScreenScraper sesuai format permainan. <strong>Byte ROM dan BIOS tidak dikirim ke ScreenScraper.</strong> ROM lokal yang dibuka lewat Buka ROM tidak ikut dipindai.</p>
      <Link className="text-link" to="/cara-bermain">Cara bermain & privasi<ArrowRight size={14} /></Link>
    </section>
    <p className="page-footnote">maindulu v{__APP_VERSION__} · Jeda kecil. Kenangan besar.</p>
  </div>
}
