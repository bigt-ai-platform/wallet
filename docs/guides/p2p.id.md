# Penyelesaian P2P — pertukaran lintas-rel bawaan wallet

**Apa ini.** Pertukaran peer-to-peer antara kripto di **Bigtangle L0** dan fiat
lewat **PayPal** (atau rel CNY — WeChat Pay / Alipay / bank). Penjual menaruh
token di **alamat P2SH 2-dari-3** (penjual, pembeli, mesin); pembeli membayar
kewajiban fiat **berjumlah tepat**; mesin membuktikan pembayaran dan melepas
escrow. Setiap langkah tak dapat dibatalkan ditandatangani dengan kunci PQ
wallet Anda sendiri, dan mesin hanya bisa **ikut-menandatangani** pengeluaran —
mesin tidak pernah memegang dana Anda.

**Di mana.** Layar **P2P** di wallet (bilah samping → Trade → P2P). Semua di
bawah ini diambil dari layar itu pada build demo lokal.

**Demo vs. live.** Tangkapan layar berasal dari build demo: mesin berjalan dalam
mode PayPal tiruan (URL faktur palsu dan hash transaksi sintetis), dan langkah
lock/verify/release ditandatangani dengan kunci mesin lokal. State machine, tanda
tangan, log peristiwa append-only, dan jangkar audit on-chain adalah sungguhan;
hanya panggilan PayPal eksternal dan siaran L0 yang dibuat stub.

**Tidak ada “Konfirmasi” manual.** Di rel PayPal tidak ada tombol “Konfirmasi”
penjual — mesin memverifikasi pembayaran dari buktinya sendiri. (Rel CNY, yang
tidak punya webhook, memakai konfirmasi eksplisit dari penjual; lihat
`docs/p2pcny.md`.)

---

## Alur sekilas

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Langkah | Siapa bertindak | On-chain / mesin |
|---|---|---|---|
| 1 | Penjual memasang order jual bertanda tangan | penjual | order tersimpan, belum didanai |
| 2 | Pembeli mencocokkan (alamat terima + akun PayPal) | pembeli | `swapId` dibuat, alamat escrow diturunkan |
| 3 | Penjual mendanai escrow 2-dari-3, mesin membuktikan kunci | penjual + mesin | `ESCROW_LOCKED` di L0 |
| 4 | Pembeli membayar faktur berjumlah tepat dan melaporkannya | pembeli | `PAYMENT_PENDING` |
| 5 | Mesin memverifikasi pembayaran sendiri | mesin | `PAYMENT_VERIFIED` |
| 6 | Mesin + pembeli ikut-menandatangani pelepasan, token berpindah | mesin + pembeli | `ESCROW_RELEASED` |
| 7 | Mesin membayar penjual lewat PayPal Payouts | mesin | `COMPLETED` |

Setiap transisi dijadikan jangkar sebagai catatan `social.p2p-swap` di rantai
L1-SOCIAL, sehingga seluruh siklus hidup dapat diaudit publik tanpa membocorkan
data PayPal salah satu pihak.

---

## 1. Penjual memasang order jual

Di tab **Open sells**, isi order: token dan jumlah yang Anda berikan, harga fiat
yang diinginkan, mata uang, rantai token, dan **metode pembayaran** (PayPal atau
rel CNY). Syarat dikunci ke dalam order saat dipasang, jadi ini ditandatangani
dengan kunci wallet Anda.

![Formulir order jual, rel PayPal dipilih](/demo/p2p/p2p-01-order-id.png)

Setelah dipasang, order berstatus `ACTIVE` di mesin dan muncul di buku order
publik (tanpa data pribadi):

![Order tampil di buku order](/demo/p2p/p2p-02-active-id.png)

---

## 2. Pembeli mencocokkan

Pembeli membuka order dan memberikan **alamat terima** untuk token yang dilepas
serta **akun PayPal** yang akan ditagih (dan email untuk faktur). Pencocokan
mengikat pembeli untuk membayar, jadi ini juga ditandatangani:

![Pembeli mengisi alamat terima dan akun PayPal](/demo/p2p/p2p-03-match-id.png)

Mesin membuat `swapId` unik untuk siklus hidup dan pertukaran pindah ke `MATCHED`,
terlihat di tab **My swaps** pembeli:

![Pertukaran berstatus MATCHED](/demo/p2p/p2p-04-matched-id.png)

---

## 3. Kunci escrow — penjual mendanai L0

Penjual mengirim token ke alamat escrow deterministik 2-dari-3 dan melaporkan
`txHash` transfernya. Mesin membuktikan kunci dari rantai (`CONFIRMED`, tujuan
`escrowAddress`, jumlah) dan gagal-tertutup jika ada pemeriksaan yang tidak
terpenuhi. Pertukaran kini `ESCROW_LOCKED`:

![Penjual mengunci escrow](/demo/p2p/p2p-05-escrow-locked-id.png)

Pembeli melihat dana terjamin **sebelum** mengirim fiat apa pun, dan mendapat
aksi **I have paid** (Saya sudah bayar) begitu kunci terbukti:

![Pembeli melihat escrow terkunci](/demo/p2p/p2p-06-buyer-locked-id.png)

---

## 4. Pembeli membayar

Pembeli membayar faktur PayPal yang dihosting (PayPal memegang uangnya — bukan
mesin) dan melaporkan pembayaran. Ini hanya *petunjuk*; verifikasi sebenarnya
adalah bukti mesin sendiri. Pertukaran berstatus `PAYMENT_PENDING`, dan timer
batas waktu mulai — jika faktur tak pernah dibayar, penjual dapat
mengakhirinya dan mengembalikan escrow tanpa persetujuan pembeli:

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-id.png)

---

## 5. Mesin memverifikasi pembayaran

Tidak ada konfirmasi penjual yang terlibat. Mesin memeriksa pembayaran dari
sumbernya sendiri dan memajukan pertukaran ke `PAYMENT_VERIFIED` — escrow kini
siap dilepas ke alamat terima pembeli:

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-id.png)

---

## 6. Pelepasan — dana berpindah

Pelepasan memindahkan token yang di-escrow: mesin dan pembeli masing-masing
menandatangani pengeluaran dari output escrow, dan dua tanda tangan memenuhi
skrip 2-dari-3. Token tiba di alamat terima pembeli dan pertukaran menjadi
`ESCROW_RELEASED`:

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-id.png)

---

## 7. Pembayaran — penjual menerima fiat

Langkah terakhir membayar penjual lewat PayPal Payouts, dan pertukaran mencapai
`COMPLETED`:

![COMPLETED](/demo/p2p/p2p-10-completed-id.png)

Hasil pembayaran (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) datang lewat webhook
PayPal atau di-poll sebagai cadangan; kegagalan dapat diulang dari `COMPLETED`
tanpa mengulang transaksi.

---

## Apa yang melindungi Anda

| Risiko | Mitigasi |
|---|---|
| Pihak lawan pergi | Dana ada di alamat P2SH 2-dari-3; tak seorang pun bisa memindahkannya sendiri |
| Kurang atau lebih bayar | Faktur berjumlah tepat, jadi dibayar penuh atau tetap belum dibayar |
| Klaim pembayaran palsu | Mesin memverifikasi pembayaran sendiri — pembayar tidak bisa mengklaimnya sendiri |
| Mesin nakal | Langkah khusus mesin memerlukan tanda tangan DID mesin; setiap transisi dijadikan jangkar dan dapat diaudit publik |
| Chargeback setelah pelepasan | `PAYMENT.CAPTURE.REVERSED` mengaktifkan pembekuan: langkah maju berhenti, refund/expire tetap bisa |
| Sengketa | `CUSTOMER.DISPUTE.*` menjeda pertukaran sampai selesai |
| Kegagalan pembayaran | `HELD`/`FAILED`/`BLOCKED` adalah status kelas satu; ulangi dengan referensi pembayaran yang sama |

---

## Menuju produksi

Demo berjalan terhadap layanan penyelesaian di dalam repo dengan PayPal tiruan.
Untuk alur nyata Anda memerlukan akun bisnis PayPal dengan Payouts aktif, kredensial
API dan webhook id-nya, serta penandatangan escrow yang tersambung ke langkah
siaran L0. Sampai saat itu, mesin menjalankan state machine yang sama tanpa
menyentuh uang nyata.
