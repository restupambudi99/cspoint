# Pembaruan tampilan CSPoint

Identitas Niaw pada dashboard diganti menjadi CSPoint. Perubahan hanya mencakup
HTML, CSS, judul halaman, serta interaksi navigasi dan panel percakapan untuk ponsel.
File gateway, autentikasi, database, MCP, dan penghubung WhatsApp tidak berubah.

## Arah desain

- Skill: design-taste-frontend / taste-skill.
- Gaya: framed-sheet, seed 1529732772, tanpa pengundian ulang.
- Bingkai sky blue sangat muda, permukaan kerja putih, aksen #0369a1.
- Nama CSPoint, simbol percakapan dengan satu titik, dan menu berlabel menjaga
  identitas produk. Font sistem dan SVG inline tidak memerlukan layanan aset luar.
- Pertanyaan utama dashboard tetap: bagaimana aktivitas pesan dan bagaimana mengirim
  pesan berikutnya? Kotak masuk tetap berpusat pada percakapan yang akan dibalas;
  pesanan, produk, dan kontak pada daftar; pengaturan pada konfigurasi yang disimpan.
- Seluruh route, ID formulir, atribut aksi, dan payload API dipertahankan.

## Verifikasi

- Sepuluh menu diperiksa di browser pada lebar 1440, 768, 390, dan 320 piksel.
  Tidak ditemukan scroll horizontal pada dokumen.
- Menu ponsel: buka, pilih halaman, tutup melalui backdrop/tombol/Escape,
  pembatasan fokus, dan pengembalian fokus diterapkan.
- Form tambah kontak dan produk diuji pada gateway lokal dengan database memori;
  pencarian kontak dan angka inventori tetap menggunakan alur yang sudah ada.
- Toggle prioritas tarif manual dan refresh status WhatsApp diuji dari browser lokal.
- Panel percakapan ponsel dan tombol kembali diuji memakai fixture pada tab QA;
  tidak ada pesan WhatsApp nyata yang dikirim.
- Lint taste-skill: 0 FAIL. Satu peringatan shadow diterima karena hanya digunakan
  oleh dialog yang mengambang.
- Inspector bawaan gagal pada koneksi Chrome (`CDP timeout: Page.enable`).
  Pengukuran viewport dan screenshot dilakukan melalui ego-browser; hasil ini
  tidak diklaim sebagai kelulusan inspector bawaan.
- Pemeriksaan sintaks, smoke test gateway, dan git diff --check lulus.

## Evaluasi screenshot

Lebar kerja desktop kini memakai ruang di sebelah navigasi, tidak berhenti pada
kolom sempit. Statistik dashboard merupakan satu strip; formulir memiliki tipografi
dan batas input konsisten. Di ponsel, menu disembunyikan sampai dibuka, tabel kontak
menjadi daftar, dan kotak masuk menampilkan satu panel setiap saat.

Status fitur yang sebelumnya belum tersedia tetap sama, termasuk billing pada
Akun & Langganan. Pembaruan tampilan tidak menambahkan kemampuan backend.
