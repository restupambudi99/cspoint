# Koneksi AI CSPoint ke 9Router

Di AI Agent → Pengaturan per Nomor tersedia konfigurasi koneksi 9Router.

1. Masukkan API key 9Router, pilih model/combo, kemudian Simpan Koneksi AI.
2. Muat Daftar Model membaca ID model dari 9Router. Model awal `Hermesollama`
   mengikuti combo aktif yang dipilih pengguna; simpan kembali jika memilih ID lain.
3. Uji Balasan AI memanggil model, tanpa mengirim pesan WhatsApp.
4. Untuk balasan pelanggan, aktifkan AI Agent dan Aktifkan balasan otomatis
   pada Pengaturan. WhatsApp harus terhubung.

Alamat publik yang ditampilkan adalah `http://38.47.191.228:20128/v1`.
Karena gateway berjalan pada VPS yang sama, permintaan dikirim ke
`http://127.0.0.1:20128/v1` agar key tidak melewati jaringan publik.
Operator dapat mengatur `NINE_ROUTER_BASE_URL` pada environment server untuk
deployment yang berbeda. URL tujuan tidak dapat diganti lewat request browser.

API key dienkripsi AES-256-GCM dengan kunci turunan GATEWAY_TOKEN dan disimpan
di tabel ai_provider dalam database gateway. Respons API hanya mengembalikan
hasApiKey. Kolom kosong saat menyimpan mempertahankan key lama. Jangan mengubah
GATEWAY_TOKEN tanpa bersiap mengisi ulang key. Backup database dan environment
harus dilindungi seperti kredensial lainnya.

Alur otomatis memproses pesan teks chat pribadi, termasuk pelanggan baru dan
lama; grup, pesan sendiri, dan sinkronisasi riwayat dikecualikan. Inbox AI tidak
memakai batas jumlah balasan atau jam operasional. Antrean diproses berurutan,
kesalahan model 502 dicoba ulang hingga empat kali, dan pesan yang gagal tetap
tersimpan untuk dicoba kembali setelah WhatsApp tersambung. Jika model tetap
gagal tetapi WhatsApp tersedia, pelanggan menerima balasan bantuan singkat.
Kedua toggle dan koneksi tetap harus aktif; jeda kirim mengikuti Pengaturan.

Konteks AI mencakup instruksi admin penuh, hingga delapan pesan terakhir,
maksimal dua kutipan Knowledge yang paling relevan, dan maksimal lima produk
yang cocok dengan percakapan. Balasan diarahkan mengumpulkan nama, alamat,
produk/varian, jumlah, dan menghitung total hanya dari harga serta ongkir yang
tersimpan; data yang tidak ada harus dikonfirmasi, tidak boleh dikarang.

Uji: node gateway/ai.test.mjs, node gateway/ai-http.test.mjs,
node gateway/smoke.test.mjs. Kedua uji AI menggunakan router tiruan dan key uji,
tanpa menggunakan akun model atau mengirim pesan WhatsApp nyata.
Koneksi model yang sebenarnya harus diuji setelah pengguna memasukkan key.

Perbaikan konfigurasi: combo `Fallback` pada VPS menunjuk provider tanpa kredensial
aktif dan menghasilkan HTTP 404 dari 9Router. Model CSPoint diganti ke `Hermesollama`
dengan key lama tetap dipertahankan. Pengujian lokal dan HTTPS publik berhasil
mengembalikan HTTP 200 serta jawaban AI. Error model/provider tidak tersedia kini
dikembalikan sebagai HTTP 422 dengan petunjuk pengaturan, bukan 502 umum.
