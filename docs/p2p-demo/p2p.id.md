# FIAT (mata uang fiat) — Tukar BIG lewat WeChat / Alipay / Bank atau PayPal

**Istilah.** FIAT = mata uang fiat; CNY = yuan Tiongkok; USD = dolar AS; P2P = peer-to-peer.

**Apa ini.** Di dompet Bigtangle, kamu menukar **BIG** langsung dengan mata uang fiat (WeChat Pay / Alipay / bank, atau **PayPal USD**). BIG milik penjual lebih dulu dimasukkan ke **alamat escrow** yang hanya dapat digunakan jika dua dari tiga pihak — penjual, pembeli, dan platform — menyetujuinya. Pembeli membayar uang langsung kepada penjual; setelah penjual mengonfirmasi di mutasi rekeningnya sendiri, BIG dilepas. Platform tidak menyimpan uangmu dan tidak menyentuh mata uang fiat.

**Tentang tangkapan layar.** Tangkapan layar di bawah berasal dari lingkungan demo di perangkat sungguhan; nominal dan hash merupakan data demo, tanpa uang sungguhan.

Panduan ini memperagakan: penjual memasang order jual BIG, pembeli membeli, escrow terkunci, pembeli membayar, penjual mengonfirmasi, BIG dilepas, serta pengembalian dana saat waktu habis. Kurs **BIG/CNY = 0.01**, order **10,000 BIG → 100 CNY**.

## Alur sekilas

```
Menunggu pencocokan → Tercocok → Escrow terkunci → Menunggu pembayaran → Pembayaran diklaim → Pembayaran dikonfirmasi → Escrow dilepas → Selesai
```

Setiap langkah ditampilkan pada kartu transaksi di aplikasi; status hanya bergerak maju, tidak melompat dan tidak mundur.

Jalur opsional: setelah pembayaran, jika kedua pihak berselisih, transaksi dapat dibekukan dan sengketa diajukan agar platform membantu memutuskan (melepas BIG ke pembeli atau mengembalikan dana ke penjual).


**PayPal (dolar AS).** Jika memilih **PayPal**, mata uang fiat otomatis berganti ke **USD** dan rekening penerima menjadi alamat email PayPal; selebihnya alurnya sama persis. Demo lengkap ada di [p2p-paypal.zh.md](p2p-paypal.zh.md) → `assets/p2p-paypal.zh.mobile.pdf` (**10,000 BIG → 100 USD**).

---

## 1. Penjual menyimpan profil pembayaran

Penjual membuka **P2P → Transaksi saya**, memilih metode pembayaran (WeChat, Alipay, bank, atau PayPal), lalu mengisi nama pemilik rekening dan nomor rekening (untuk PayPal, alamat email). Informasi ini hanya ditampilkan kepada pembeli setelah transaksi cocok dan tidak muncul di buku order publik.

![Penjual menyimpan profil WeChat Pay](assets/screenshots/p2p-cny-wechat-01-profile-id.png)

---

## 2. Penjual memasang order BIG

Penjual mengisi di **Terbitkan order jual**: token (`bc`), jumlah **10,000**, harga **0.01**, mata uang fiat **CNY**, dan metode pembayaran **WeChat**, lalu menerbitkannya.

Setelah diterbitkan, order jual muncul di buku order publik dengan status **Menunggu pencocokan**. Penjual dapat membatalkan order jual yang belum cocok kapan saja.

![Memasang order jual dengan wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-id.png)

---

## 3. Pembeli mencocokkan order

Pembeli membuka order jual, mengisi alamat penerima BIG, lalu mengonfirmasi pembelian. Rekening WeChat atau Alipay belum perlu diisi di sini — informasi pembayaran penjual baru ditampilkan khusus kepada pembeli ini setelah escrow terkunci.

Aplikasi membuat nomor transaksi unik untuk transaksi ini dan menyiapkan alamat escrow; status berubah menjadi **Tercocok**.

![Pembeli mengisi alamat penerima](assets/screenshots/p2p-cny-wechat-03-match-id.png)

![Pertukaran dibuat pada status Tercocok](assets/screenshots/p2p-cny-wechat-04-matched-id.png)

---

## 4. Penjual mengunci BIG ke escrow

Aplikasi membuat **alamat escrow 2-dari-3** untuk transaksi ini: hanya jika dua dari tiga pihak — penjual, pembeli, dan platform — menyetujui, dana dapat digunakan; tidak ada pihak yang bisa mengambilnya sendiri.

Penjual mengirim **10,000 BIG** ke alamat tersebut dan menempelkan hash transaksi pengiriman itu di aplikasi. Setelah aplikasi memeriksa nominal dan alamat penerima, status berubah menjadi **Escrow terkunci**. Pembeli sudah dapat melihat bahwa BIG terkunci sebelum membayar mata uang fiat.

![Penjual menempelkan hash transaksi escrow](assets/screenshots/p2p-cny-wechat-05-escrow-lock-id.png)

![Escrow terkunci](assets/screenshots/p2p-cny-wechat-06-escrow-locked-id.png)

---

## 5. Pembeli membuka petunjuk pembayaran

Pembeli mengetuk **Detail pembayaran** dan melihat:

- nama pemilik rekening penjual
- rekening penerima (rekening WeChat / Alipay / bank, atau email PayPal)
- nominal tepat **100 CNY**
- **kode catatan** yang khusus untuk transaksi ini
- batas waktu pembayaran

Saat mentransfer, pembeli wajib mengisi kode catatan pada keterangan. Status berubah menjadi **Menunggu pembayaran**; jika batas waktu terlewati tanpa pembayaran, transaksi kedaluwarsa dan dana dikembalikan.

![Petunjuk pembayaran: nama, rekening, 100 CNY, catatan](assets/screenshots/p2p-cny-wechat-08-instructions-id.png)

---

## 6. Pembeli membayar CNY dan mengklaim

Pembeli mentransfer **100 CNY** di WeChat miliknya, mengisi kode catatan pada keterangan, lalu menempelkan nomor transaksi (nomor referensi) ke **Nomor transaksi** dan menekan **Saya sudah membayar**.

Gambar bukti pembayaran boleh dilampirkan; gambar hanya disimpan di server dan tidak ditulis ke blockchain.

![Nomor transaksi (nomor referensi) sudah diisi](assets/screenshots/p2p-cny-wechat-09-payment-pending-id.png)

Status berubah menjadi **Pembayaran diklaim**. Saat ini BIG masih terkunci; ini hanya pernyataan pembayaran dari pembeli.

![Pembayaran diklaim](assets/screenshots/p2p-cny-wechat-10-payment-claimed-id.png)

---

## 7. Penjual mengonfirmasi di mutasi rekeningnya sendiri

Kartu transaksi penjual menampilkan nomor referensi dan catatan yang diisi pembeli. Penjual hanya memeriksa di mutasi WeChat miliknya sendiri: **nominal + catatan + waktu + nomor referensi**, dan baru menekan **Konfirmasi penerimaan** setelah semuanya benar.

Tangkapan layar tidak berlaku sebagai bukti; yang menjadi acuan adalah dana yang benar-benar masuk ke rekeningmu sendiri.

![Penjual melihat nomor referensi + peringatan konfirmasi](assets/screenshots/p2p-cny-wechat-11-seller-confirm-id.png)

Status berubah menjadi **Pembayaran dikonfirmasi**.

![Pembayaran dikonfirmasi](assets/screenshots/p2p-cny-wechat-12-payment-verified-id.png)

---

## 8. Penjual melepas escrow

> **Penjual, lepaskan escrow secepatnya.** Setelah mengonfirmasi penerimaan, segera ketuk **Lepas dana**. Pelepasan yang tertunda menurunkan rating penjual; keterlambatan berat atau berulang akan menandai penjual sebagai **tidak aman**, yang memengaruhi order berikutnya.

Setelah mengonfirmasi penerimaan, penjual langsung mengetuk **Lepas dana**; platform ikut menandatangani, dan BIG dikirim ke alamat penerima pembeli. Tanda tangan penjual dan tanda tangan platform sudah cukup untuk melepas dana; tidak ada pihak yang bisa memindahkan uang itu sendiri.

Karena penjual menerima fiat secara langsung, tidak ada langkah pencairan fiat tambahan, dan transaksi pun selesai.

![Escrow dilepas](assets/screenshots/p2p-cny-wechat-13-escrow-released-id.png)

![Selesai](assets/screenshots/p2p-cny-wechat-14-completed-id.png)

Status berubah menjadi **Selesai**.

---

## 9. Opsional: sengketa dibantu keputusan platform

Jika kedua pihak berselisih tentang pembayaran (nominal tidak sesuai, dana tidak diterima, penjual lama tidak melepas, dan sebagainya), salah satu pihak dapat membekukan transaksi dan mengajukan sengketa. Setelah memeriksa escrow dan bukti pembayaran, platform memutuskan untuk **melepas BIG ke pembeli** atau **mengembalikan dana ke penjual**.

Kekalahan dan keterlambatan berulang penjual dicatat dalam reputasi; pada kasus berat, penjual ditandai sebagai **tidak aman**.

---

## 10. Waktu habis atau gagal → pengembalian dana

Jika pembeli tidak pernah membayar, penjual dapat membiarkan transaksi kedaluwarsa; BIG yang ada di escrow kembali kepada penjual tanpa perlu persetujuan pembeli.

Tidak ada pihak yang pernah memegang dana pihak lain.

---

## 11. Opsional: «Verifikasi dengan ponsel saya» (pembeli, pelepasan tertunda)

Ini bukan langkah wajib dalam penyelesaian normal. Pembeli hanya melihat **«Verifikasi dengan ponsel saya»** jika penjual menunda pelepasan (lebih dari **30 menit** setelah pembeli mengklaim pembayaran, atau sudah dikonfirmasi tetapi tidak segera dilepas) **atau** sengketa telah dibuka.

Itu hanya ditampilkan untuk **Alipay / bank**, karena sisi pembeli dapat membaca catatan transfer; WeChat hanya memberi notifikasi kepada penerima, dan PayPal tidak menyediakan akses baca, sehingga keduanya tidak menampilkannya. Pembeli membaca sekali dengan ponsel yang sudah dipasangkan, dompet menandatangani hasilnya dan mengirimkannya; verifikasi tercatat dalam reputasi penjual, tetapi tidak dapat menggantikan pelepasan yang seharusnya segera dilakukan penjual.

---

## Perbandingan: Binance P2P dan penyelesaian ini

| Fitur | Binance P2P | Penyelesaian ini |
|---|---|---|
| Verifikasi fiat | Penjual mengetuk "Konfirmasi" (sistem reputasi) | Penjual mengonfirmasi di mutasi rekeningnya sendiri, platform melepas BIG sesuai alur |
| Kustodi fiat | Platform (pembeli → penjual) | Pembeli membayar langsung ke penjual, platform tidak menyentuh fiat |
| Escrow | Buku besar internal platform | Escrow 2-dari-3 di blockchain, dapat diperiksa publik |
| Pengembalian dana | Tiket dukungan | Transaksi kedaluwarsa otomatis kembali ke penjual |
| Penyelesaian sengketa | Layanan pelanggan manusia (berhari-hari) | Sengketa dalam aplikasi + keputusan platform (lebih cepat) |

---

## Linimasa

```
Tercocok                14:20  Nominal ditetapkan saat cocok
Escrow terkunci         14:23  Penjual mengirim BIG, aplikasi mengonfirmasi penerimaan
Menunggu pembayaran     14:24  Pembeli melihat petunjuk pembayaran
Pembayaran diklaim      14:25  Pembeli membayar dan mengisi nomor referensi
Pembayaran dikonfirmasi 14:26  Penjual mengonfirmasi di mutasi rekeningnya
Escrow dilepas          14:27  Penjual dan platform menandatangani bersama, BIG dikirim ke pembeli
Selesai                 14:27  Transaksi berakhir
```

---

Jika kamu ingin memahami detail implementasi mesin status, tanda tangan, skrip escrow, dan antarmuka, lihat dokumentasi pengembang `docs/p2p.md`.
