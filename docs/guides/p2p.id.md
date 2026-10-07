# Penyelesaian P2P — Pertukaran Lintas Jalur dengan Verifikasi AI

**Status: desain target, belum dibangun.** Di bawah ini adalah alur penyelesaian yang sedang kami bangun: escrow P2SH 2-of-3 di Bigtangle L0 dan verifikasi API PayPal yang nyata. Build demo yang berjalan hari ini adalah mesin status di atas Postgres dengan kaki fiat yang disimulasikan. Tangkapan layar berasal dari build demo tersebut; desain ada di repositori dai, `docs/p2p.md`.

Panduan ini mendemonstrasikan alur penyelesaian P2P native-AI: mendaftarkan USDT untuk dijual, pencocokan dengan pembeli, penguncian escrow, pembayaran fiat dengan verifikasi otomatis, pelepasan escrow, dan pengembalian dana saat waktu habis. Tanpa tombol "Konfirmasi" manual — Mekanisme Penyelesaian memverifikasi pembayaran dari webhook PayPal.

---

## 1. Ikhtisar Dasbor

Dasbor P2P menampilkan semua pertukaran aktif dengan status saat ini, tarif, dan referensi transaksi.

![Dasbor](demo-output/screenshots/p2p-dashboard-id.png)

Dasbor menampilkan semua pertukaran aktif dengan status, tarif, dan referensi transaksi. Setiap kartu menampilkan ID pertukaran, pasangan aset (mis. 100 USDT ⇄ 101 USD), lencana status berwarna, dan garis waktu yang dapat diperluas.

---

## 2. Penjual Mendaftarkan USDT

Kirim order batas bertanda tangan DID ke Mekanisme Penyelesaian.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

Penjual mengirim order batas bertanda tangan: menjual 100 USDT seharga 101 USD via PayPal. Mekanisme Penyelesaian memvalidasi tanda tangan DID. Status: ACTIVE. Order kedaluwarsa setelah validUntil.

---

## 3. Pembeli Mencocokkan Order

Pembeli mengirim order pasar bertanda tangan. Tarif dikunci saat pencocokan lewat sebuah oracle, dan nilai tagihan ditetapkan sejak saat itu.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

Pembeli mencocokkan order dengan order pasar bertanda tangan DID, menyediakan alamat yang harus menerima pelepasan escrow dan akun PayPal yang akan dibayar. Status: MATCHED. Sebuah swapId unik dibuat untuk seluruh siklus hidup.

---

## 4. Penjual Mengunci USDT di Escrow 2-of-3

Alamat escrow adalah skrip P2SH dengan tiga kunci — penjual, pembeli, mekanisme — dengan ambang dua.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

Penjual mendanai alamat escrow di Bigtangle L0. Mekanisme membuktikan penguncian dengan `getTransactionStatus` — `CONFIRMED`, tujuan `escrowAddress`, jumlah 100 — dan gagal tertutup jika salah satu dari tiga pemeriksaan tidak terpenuhi. Status: ESCROW_LOCKED. Pembeli melihat dana terlindungi sebelum mengirim uang.

---

## 5. Mekanisme Menerbitkan Tagihan, Pembeli Membayar via PayPal

Mekanisme membuat tagihan PayPal dengan jumlah tepat dan menyerahkan URL hosting ke pembeli.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → URL checkout hosting; nomor tagihan = swapId
```

Pembeli membayar tagihan hosting. Mekanisme tidak menyentuh uang — PayPal yang menahannya. Tanpa konfirmasi penjual. Status: PAYMENT_PENDING. Timer waktu habis dimulai.

---

## 6. Mekanisme Memverifikasi Pembayaran Otomatis

**Inovasi utama**: tidak ada tombol "Konfirmasi" manual. Pembayaran dibuktikan oleh PayPal, bukan diklaim oleh salah satu pihak.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

Mekanisme memverifikasi webhook `INVOICING.INVOICE.PAID`, dideduplikasi pada `event.id`. Ini menggantikan tombol "Konfirmasi" manual Binance P2P. Tidak ada penjual yang bisa berbohong bahwa pembayaran tidak diterima. Status: PAYMENT_VERIFIED.

---

## 7. Mekanisme dan Pembeli Melepas Escrow

Dua tanda tangan memenuhi skrip: milik pembeli dan milik mekanisme. Tidak ada satu pihak pun yang bisa menggerakkan dana sendirian.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Pengeluaran pelepasan dirakit dan disiarkan ke `receiveAddress`. Status: ESCROW_RELEASED. Pembeli kini memegang token; sisa pekerjaan mekanisme adalah pembayaran fiat.

---

## 8. Mekanisme Membayar Penjual

Mekanisme mengirim USD ke PayPal penjual melalui Payouts v1, idempoten per pertukaran.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

Mekanisme mengirim USD ke PayPal penjual. Pertukaran COMPLETED. Total waktu: ~3-5 menit. Semuanya bertanda tangan DID, setiap langkah dapat diaudit di rantai atau di PayPal.

---

## 9. Waktu Habis atau Gagal → Pengembalian Dana

Jika tagihan tidak pernah dibayar, mekanisme dan penjual menandatangani skrip yang sama kembali ke penjual.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Pengembalian dana tidak memerlukan persetujuan pembeli maupun timelock — ambang tercapai dengan dua kunci lainnya. Status: EXPIRED → ESCROW_REFUNDED. Tidak ada pihak yang pernah memegang dana pihak lain.

---

## 10. Tampilan Riwayat

Pertukaran yang selesai, kedaluwarsa, dan dibatalkan terlihat di halaman riwayat.

![Riwayat](demo-output/screenshots/p2p-history-id.png)

Halaman riwayat mendaftarkan pertukaran yang selesai, kedaluwarsa, dan dibatalkan. Setiap entri menampilkan pasangan aset, status akhir, langkah garis waktu, dan DID para pihak.

---

## Perbandingan: Binance P2P vs Penyelesaian AI

| Fitur | Binance P2P | Penyelesaian AI |
|---------|-------------|---------------|
| Verifikasi fiat | Penjual mengklik "Konfirmasi" (sistem kehormatan) | Webhook PayPal, diverifikasi RSA (deterministik) |
| Kustodi fiat | P2P (pembeli → penjual) | PayPal menahan sampai pembayaran (pembeli → PayPal → penjual) |
| Escrow | Buku besar internal | P2SH 2-of-3 di Bigtangle L0 (dapat diverifikasi) |
| Pengembalian dana | Tiket dukungan | Mekanisme + penjual menandatangani bersama, tanpa persetujuan pembeli |
| Penyelesaian sengketa | Dukungan manusia (hari) | Bukti transaksi di rantai + acara PayPal (menit) |

---

## Garis Waktu Lengkap

```
MATCHED          14:20:00  Tarif dikunci, nilai tagihan ditetapkan
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMED di alamat 2-of-3
PAYMENT_PENDING  14:24:00  Tagihan INV-7f3c91 diterbitkan
PAYMENT_VERIFIED 14:24:10  Webhook INVOICING.INVOICE.PAID, diverifikasi RSA
ESCROW_RELEASED  14:24:30  Pengeluaran co-signed ke receiveAddress
COMPLETED        14:25:00  Batch pembayaran PAYOUT-abc SUCCESS
```

---

## Alur Demo Lengkap

```typescript
// 1. Penjual mengirim order batas bertanda tangan (POST /api/p2p/orders)
// 2. Pembeli mencocokkan dengan order pasar bertanda tangan (POST /api/p2p/orders/:id/match)
// 3. Penjual mendanai escrow P2SH 2-of-3 di L0; mekanisme membuktikan (getTransactionStatus)
// 4. Mekanisme menerbitkan tagihan PayPal; pembeli membayar (POST /api/p2p/payments/invoice)
// 5. Mekanisme memverifikasi webhook INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. Mekanisme + pembeli menandatangani pengeluaran pelepasan (POST .../transitions, action: release)
// 7. Mekanisme membayar penjual (POST /api/p2p/payments/payout)
// 8. Kedua pihak melihat status COMPLETED di dasbor
```

Perbedaan utama dari Binance P2P: **tanpa tombol "Konfirmasi" penjual.** Pembayaran dibuktikan oleh webhook PayPal dan dana berada di skrip 2-of-3 yang tidak dikontrol satu pihak mana pun — deterministik, dapat diaudit, instan.
