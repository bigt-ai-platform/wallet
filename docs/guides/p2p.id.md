# Penyelesaian P2P — pertukaran CNY bawaan wallet

**Apa ini.** Pertukaran peer-to-peer antara kripto di **Bigtangle L0** dan fiat
CNY (WeChat Pay / Alipay / bank). Penjual menaruh token di escrow pada **alamat
P2SH 2-dari-3** (penjual, pembeli, mesin); pembeli membayar penjual **langsung**
di aplikasi pembayarannya sendiri; penjual mengonfirmasi penerimaan pada
mutasinya sendiri dan escrow dilepas. Setiap langkah tak dapat dibatalkan
ditandatangani dengan kunci PQ wallet Anda sendiri, dan mesin hanya bisa
**ikut-menandatangani** pengeluaran — mesin tidak pernah memegang dana Anda dan
tidak pernah menyentuh fiat.

**Di mana.** Layar **P2P** di wallet (bilah samping → Trade → P2P). Semua di
bawah ini diambil dari layar itu pada build demo lokal.

**Demo vs. live.** Tangkapan layar berasal dari build demo: mesin berjalan
dengan penyimpanan memori dan tanpa pemeriksaan rantai, jadi langkah lock/release
memakai hash transaksi sintetis. State machine, tanda tangan, log peristiwa
append-only, dan jangkar audit on-chain adalah sungguhan; hanya siaran L0 yang
dibuat stub.

**Konfirmasi penjual adalah sinyal fiat.** Tidak ada API penagihan untuk akun
pribadi WeChat/Alipay/bank, jadi tidak ada peristiwa pembayaran yang dapat
diverifikasi mesin untuk ditunggu. Penjual memeriksa **jumlah + keterangan +
waktu + 流水号 di aplikasinya sendiri** — tangkapan layar tidak pernah dihitung —
lalu mengonfirmasi. Detail desain ada di `docs/p2p.md`.

---

## Alur sekilas

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──instructions──▶ PAYMENT_PENDING
                                                                          │
   PAYMENT_PENDING ──proof──▶ PAYMENT_CLAIMED ──confirm──▶ PAYMENT_VERIFIED
                                                                  │
                            PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──complete──▶ COMPLETED
```

| # | Langkah | Siapa bertindak | On-chain / mesin |
|---|---|---|---|
| 1 | Penjual menyimpan profil penagihan CNY | penjual | profil disimpan di server, tidak pernah di buku |
| 2 | Penjual memasang order jual bertanda tangan | penjual | order tersimpan, belum didanai |
| 3 | Pembeli mencocokkan (alamat terima) | pembeli | `swapId` dibuat, alamat escrow diturunkan |
| 4 | Penjual mendanai escrow 2-dari-3, mesin membuktikan kunci | penjual + mesin | `ESCROW_LOCKED` di L0 |
| 5 | Pembeli menarik instruksi pembayaran | pembeli | `PAYMENT_PENDING` (+ keterangan per pertukaran) |
| 6 | Pembeli membayar di aplikasinya sendiri dan mengklaim dengan 流水号 | pembeli | `PAYMENT_CLAIMED` |
| 7 | Penjual memeriksa mutasinya sendiri dan mengonfirmasi | penjual | `PAYMENT_VERIFIED` |
| 8 | Mesin melepas token, pertukaran selesai | mesin | `ESCROW_RELEASED` → `COMPLETED` |

Setiap transisi dijadikan jangkar sebagai catatan `social.p2p-swap` di rantai
L1-SOCIAL, sehingga seluruh siklus hidup dapat diaudit publik tanpa membocorkan
data akun salah satu pihak.

---

## 1. Penjual menyimpan profil penagihan

Di tab **My swaps**, penjual memilih rel (WeChat, Alipay, atau bank) dan
memasukkan nama 收款 dan akunnya. Profil disimpan di server di bawah DID penjual
dan **bukan** bagian dari buku order publik — profil hanya diungkapkan kepada
pembeli yang cocok melalui panggilan instruksi.

![Penjual menyimpan profil pembayaran WeChat](/demo/p2p/p2p-cny-wechat-01-profile-id.png)

---

## 2. Penjual memasang order jual

Di tab **Open sells**, isi order: token dan jumlah yang Anda berikan, harga CNY
yang diinginkan, rantai tempat token berada, dan **metode pembayaran**
(wechat / alipay / bank). Memilih rel CNY mengubah mata uang menjadi CNY. Syarat
dikunci ke dalam order saat dipasang, jadi ini ditandatangani dengan kunci wallet
Anda:

![Formulir order jual dengan rel wechat](/demo/p2p/p2p-cny-wechat-02-order-id.png)

Setelah dipasang, order berstatus `ACTIVE` di mesin dan muncul di buku order
publik (tanpa data pribadi).

---

## 3. Pembeli mencocokkan

Pembeli membuka order dan memberikan **alamat terima** untuk token yang dilepas.
Pencocokan mengikat pembeli untuk membayar, jadi ini juga ditandatangani:

![Pembeli mengisi alamat terima](/demo/p2p/p2p-cny-wechat-03-match-id.png)

Mesin membuat `swapId` unik untuk siklus hidup dan pertukaran pindah ke `MATCHED`,
terlihat di tab **My swaps** pembeli:

![Pertukaran berstatus MATCHED](/demo/p2p/p2p-cny-wechat-04-matched-id.png)

---

## 4. Kunci escrow — penjual mendanai L0

Penjual mengirim token ke alamat escrow deterministik 2-dari-3 dan melaporkan
`txHash` transfernya. Mesin membuktikan kunci dari rantai (`CONFIRMED`, tujuan
`escrowAddress`, jumlah) dan gagal-tertutup jika ada pemeriksaan yang tidak
terpenuhi:

![Penjual menempelkan hash transaksi escrow](/demo/p2p/p2p-cny-wechat-05-escrow-lock-id.png)

Pertukaran kini `ESCROW_LOCKED`. Pembeli melihat dana terjamin **sebelum**
mengirim fiat apa pun, dan mendapat aksi **Payment details** (Detail pembayaran):

![ESCROW_LOCKED](/demo/p2p/p2p-cny-wechat-06-escrow-locked-id.png)

---

## 5. Pembeli menarik instruksi pembayaran

Pembeli menekan **Payment details** (Detail pembayaran); mesin mengungkapkan
profil penjual dan membuat **kode keterangan per pertukaran** yang *harus*
dibawa transfer, plus jumlah persisnya dan tenggat waktu. Instruksi ditampilkan
inline di kartu pertukaran:

![Instruksi pembayaran: 户名, akun, 715 CNY, keterangan](/demo/p2p/p2p-cny-wechat-08-instructions-id.png)

Pertukaran berstatus `PAYMENT_PENDING`, dan timer batas waktu mulai — jika
pembeli tak pernah membayar, penjual dapat mengakhirinya dan mengembalikan escrow
tanpa persetujuan pembeli.

---

## 6. Pembeli membayar dan mengklaim dengan 流水号

Pembeli mentransfer jumlah persisnya di aplikasi WeChat/Alipay/bank miliknya
sendiri, menempelkan nomor transaksi (流水号) ke **Transaction ID**, dan menekan
**I have paid** (Saya sudah bayar). Gambar bukti opsional disimpan di server;
hanya `sha256`-nya yang dijadikan jangkar pada peristiwa pertukaran:

![Transaction ID (流水号) dimasukkan](/demo/p2p/p2p-cny-wechat-09-payment-pending-id.png)

Status kini `PAYMENT_CLAIMED` — **token masih terkunci.** Status ini ada murni
sebagai klaim pembeli:

![PAYMENT_CLAIMED](/demo/p2p/p2p-cny-wechat-10-payment-claimed-id.png)

---

## 7. Penjual mengonfirmasi pada mutasinya sendiri

Kartu penjual menampilkan 流水号 pembeli dan keterangannya. Penjual memeriksa
**jumlah + keterangan + waktu + 流水号 di akunnya sendiri** dan baru kemudian
menekan **Confirm received** (Konfirmasi diterima):

![Penjual melihat 流水号 dan peringatan konfirmasi](/demo/p2p/p2p-cny-wechat-11-seller-confirm-id.png)

Pertukaran berstatus `PAYMENT_VERIFIED`:

![PAYMENT_VERIFIED](/demo/p2p/p2p-cny-wechat-12-payment-verified-id.png)

---

## 8. Pelepasan — dana berpindah

Pelepasan memindahkan token yang di-escrow: penjual (presign atau co-sign) dan
mesin masing-masing menandatangani pengeluaran dari output escrow, dan dua tanda
tangan memenuhi skrip 2-dari-3. Token tiba di alamat terima pembeli:

![ESCROW_RELEASED](/demo/p2p/p2p-cny-wechat-13-escrow-released-id.png)

Karena penjual dibayar langsung, tidak ada langkah pembayaran fiat — pertukaran
selesai:

![COMPLETED](/demo/p2p/p2p-cny-wechat-14-completed-id.png)

---

## Apa yang melindungi Anda

| Risiko | Mitigasi |
|---|---|
| Pihak lawan pergi | Dana ada di alamat P2SH 2-dari-3; tak seorang pun bisa memindahkannya sendiri |
| Kurang atau lebih bayar | Jumlahnya ditetapkan saat pencocokan; instruksi membawa angka persisnya dan keterangan per pertukaran |
| Klaim pembayaran palsu | Klaim pembeli saja tidak pernah melepas — penjual mengonfirmasi pada mutasinya sendiri |
| Penjual mengklaim tidak menerima | Arbitrase; catatan rantai dan penyimpanan bukti adalah barang buktinya |
| Mesin nakal | Langkah khusus mesin memerlukan tanda tangan DID mesin; setiap transisi dijadikan jangkar dan dapat diaudit publik |
| Sengketa | Salah satu pihak membekukan pertukaran; token tetap terkunci sampai selesai |
| Pengembalian dana | `expire` → `refund`, ikut-ditandatangani oleh mesin dan penjual — tanpa persetujuan pembeli, tanpa timelock |

---

## Menuju produksi

Demo berjalan terhadap layanan penyelesaian di dalam repo dengan penyimpanan
memori dan tanpa pemeriksaan rantai. Alur nyata menyambungkan penandatangan
escrow ke langkah siaran L0 dan menjalankan mesin terhadap L1-SOCIAL untuk buku
order dan jangkar audit; pembeli membayar penjual langsung, dan mesin tetap hanya
ikut-menandatangani.
