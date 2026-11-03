# Koneksi AI CSPoint ke 9Router

Di AI Agent → Pengaturan per Nomor tersedia konfigurasi koneksi 9Router.

1. Masukkan API key 9Router, pilih model/combo, kemudian Simpan Koneksi AI.
2. Muat Daftar Model membaca ID model dari 9Router. Model awal `Fallback` adalah
   combo yang terdeteksi pada VPS; simpan kembali jika memilih ID lain.
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

Alur otomatis hanya memproses pesan teks baru dari chat pribadi, bukan grup,
pesan sendiri, atau sinkronisasi riwayat. Pesan yang sudah tersimpan tidak memicu
balasan kedua. Batas harian menghitung slot percobaan AI dalam tanggal WIB;
0 berarti tanpa batas. Kesalahan tidak dicoba ulang otomatis. Antrean dibatasi
20 pesan dan diproses berurutan. Jam operasional, interval kirim, kedua toggle,
dan koneksi diperiksa sebelum mengirim. Reconnect atau perubahan konfigurasi
saat inferensi berlangsung membatalkan pengiriman lama.

Konteks AI: instruksi admin, 12 pesan terakhir, dan hingga 30 produk terbaru.
PDF dan kalkulasi tarif ongkir belum digunakan oleh mesin AI ini.

Uji: node gateway/ai.test.mjs, node gateway/ai-http.test.mjs,
node gateway/smoke.test.mjs. Kedua uji AI menggunakan router tiruan dan key uji,
tanpa menggunakan akun model atau mengirim pesan WhatsApp nyata.
Koneksi model yang sebenarnya harus diuji setelah pengguna memasukkan key.
