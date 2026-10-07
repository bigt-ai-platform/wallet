# التسوية عبر التبادل المباشر (P2P) — تبادل عابر للقنوات مع تحقق بالذكاء الاصطناعي

**الحالة: تصميم مستهدف، لم يُبنَ بعد.** فيما يلي تدفق التسوية الذي نبنيه: ضمان P2SH من نوع 2-of-3 على Bigtangle L0 وتحقق حقيقي عبر واجهة PayPal API. الإصدار التجريبي العامل اليوم هو آلة حالات على Postgres مع جانب نقدي وهمي. لقطات الشاشة من ذلك الإصدار التجريبي؛ التصميم موجود في مستودع dai، `docs/p2p.md`.

يوضح هذا الدليل تدفق التسوية الأصلي بالذكاء الاصطناعي: عرض USDT للبيع، مطابقة المشتري، قفل الضمان، الدفع النقدي مع التحقق الآلي، تحرير الضمان، والاسترداد عند انتهاء المهلة. لا يوجد زر "تأكيد" يدوي — يتحقق محرّك التسوية من الدفع عبر webhook الخاص بـ PayPal.

---

## 1. نظرة عامة على لوحة المعلومات

تعرض لوحة معلومات P2P جميع التبادلات النشطة مع حالتها الحالية ومعدل التبادل ومراجع المعاملات.

![لوحة المعلومات](demo-output/screenshots/p2p-dashboard-ar.png)

تعرض لوحة المعلومات جميع التبادلات النشطة مع الحالة والمعدل ومراجع المعاملات. يعرض كل بطاقة معرّف التبادل وزوج الأصول (مثل 100 USDT ⇄ 101 USD) وشارة الحالة الملوّنة وخط زمني قابلاً للتوسيع.

---

## 2. يعرض البائع USDT

يقدّم البائع أمر شراء محدود موقّعًا بـ DID إلى محرّك التسوية.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

يقدّم البائع أمرًا محدودًا موقّعًا: بيع 100 USDT مقابل 101 دولارًا عبر PayPal. يتحقق محرّك التسوية من توقيع DID. الحالة: ACTIVE. ينتهي الأمر بعد validUntil.

---

## 3. يطابق المشتري الأمر

يقدّم المشتري أمر سوق موقّعًا. يُقفل المعدل عند وقت المطابقة عبر نبوءة (oracle)، ومبلغ الفاتورة يُثبَّت من هذه اللحظة.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

يطابق المشتري الأمر بأمر سوق موقّع بـ DID، مع تقديم العنوان الذي يجب أن يستقبل تحرير الضمان وحساب PayPal الخاص بالدفع. الحالة: MATCHED. يُنشأ معرّف swapId فريد لدورة الحياة كاملة.

---

## 4. يقفل البائع USDT في ضمان 2-of-3

عنوان الضمان هو سكربت P2SH بثلاث مفاتيح — البائع والمشتري والمحرّك — وعتبة اثنتان.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

موّل البائع عنوان الضمان على Bigtangle L0. يثبت المحرّك القفل عبر `getTransactionStatus` — `CONFIRMED`، والوجهة `escrowAddress`، والمبلغ 100 — ويفشل بأمان إذا لم يتحقق أي من الفحصين الثلاثة. الحالة: ESCROW_LOCKED. يرى المشتري أن الأموال مؤمّنة قبل إرسال النقد.

---

## 5. يصدر المحرّك فاتورة، ويدفع المشتري عبر PayPal

ينشئ المحرّك فاتورة PayPal بمبلغ دقيق ويسلّم الرابط المُستضاف للمشتري.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → رابط الدفع المُستضاف؛ رقم الفاتورة = swapId
```

يدفع المشتري الفاتورة المُستضافة. المحرّك لا يمسّ المال — PayPal يحتفظ به. لا حاجة لتأكيد البائع. الحالة: PAYMENT_PENDING. يبدأ مؤقّت انتهاء المهلة.

---

## 6. يتحقق المحرّك من الدفع تلقائيًا

**الابتكار الرئيسي**: لا زر "تأكيد" بشري. يُثبت الدفع بواسطة PayPal، لا بادّعاء أحد الأطراف.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

يتحقق المحرّك من webhook الخاص بـ `INVOICING.INVOICE.PAID` مع إزالة التكرار حسب `event.id`. هذا يحل محل زر "تأكيد" اليدوي في Binance P2P. لا يستطيع أي بائع الكذب بحجة عدم الاستلام. الحالة: PAYMENT_VERIFIED.

---

## 7. يحرّر المحرّك والمشتري الضمان

توقيعان يكفيان للسكربت: توقيع المشتري وتوقيع المحرّك. لا يمكن لأي طرف وحده تحريك الأموال.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

يُجمَّع إنفاق التحرير ويُبثّ إلى `receiveAddress`. الحالة: ESCROW_RELEASED. يملك المشتري الآن العملات؛ وما يتبقى للمحرّك هو الدفع النقدي.

---

## 8. يدفع المحرّك للبائع

يرسل المحرّك USD إلى PayPal الخاص بالبائع عبر Payouts v1، مع مطابقة تبادل مُتكررة (idempotent).

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

يرسل المحرّك USD إلى PayPal الخاص بالبائع. التبادل COMPLETED. الوقت الإجمالي: ~3-5 دقائق. كل خطوة موقّعة بـ DID وقابلة للتدقيق على السلسلة أو لدى PayPal.

---

## 9. انتهاء المهلة أو الفشل → استرداد

إذا لم تُدفع الفاتورة أبدًا، يوقّع المحرّك والبائع معًا على السكربت نفسه لإعادة الأموال للبائع.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

لا يحتاج الاسترداد إلى موافقة المشتري ولا إلى قفل زمني — تتحقق العتبة بالمفتاحين الآخرين. الحالة: EXPIRED → ESCROW_REFUNDED. لم يملك أي طرف أبدًا أموال الطرف الآخر.

---

## 10. عرض السجل

التبادلات المكتملة والمنتهية والمُلغاة تظهر في صفحة السجل.

![السجل](demo-output/screenshots/p2p-history-ar.png)

تصف صفحة السجل التبادلات المكتملة والمنتهية والمُلغاة. تُظهر كل إدخال زوج الأصول والحالة النهائية وخطوات الخط الزمني ومهامّ الأطراف (DIDs).

---

## المقارنة: Binance P2P مقابل التسوية بالذكاء الاصطناعي

| الميزة | Binance P2P | التسوية بالذكاء الاصطناعي |
|---------|-------------|---------------|
| التحقق النقدي | البائع يضغط "تأكيد" (نظام شرف) | webhook من PayPal، متحقق RSA (حتمي) |
| الحفظ النقدي | مباشر بين الطرفين (مشتري → بائع) | PayPal يحتفظ حتى الدفع (مشتري → PayPal → بائع) |
| الضمان | دفتر داخلي | P2SH من نوع 2-of-3 على Bigtangle L0 (قابل للتحقق) |
| الاسترداد | تذكرة دعم | المحرّك والبائع يوقّعان معًا، دون موافقة المشتري |
| حل النزاعات | دعم بشري (أيام) | إثبات معاملة على السلسلة + حدث PayPal (دقائق) |

---

## الخط الزمني الكامل

```
MATCHED          14:20:00  قُفل المعدل، ثُبّت مبلغ الفاتورة
ESCROW_LOCKED    14:23:15  معاملة L0 CONFIRMED على عنوان 2-of-3
PAYMENT_PENDING  14:24:00  صدرت الفاتورة INV-7f3c91
PAYMENT_VERIFIED 14:24:10  webhook INVOICING.INVOICE.PAID، متحقق RSA
ESCROW_RELEASED  14:24:30  إنفاق موقّع معًا إلى receiveAddress
COMPLETED        14:25:00  دفعة PAYOUT-abc SUCCESS
```

---

## تدفق العرض الكامل

```typescript
// 1. البائع يقدّم أمرًا محدودًا موقّعًا (POST /api/p2p/orders)
// 2. المشتري يطابق بأمر سوق موقّع (POST /api/p2p/orders/:id/match)
// 3. البائع يموّل ضمان P2SH من نوع 2-of-3 على L0؛ المحرّك يثبت ذلك (getTransactionStatus)
// 4. المحرّك يصدر فاتورة PayPal؛ المشتري يدفع (POST /api/p2p/payments/invoice)
// 5. المحرّك يتحقق من webhook الخاص بـ INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. المحرّك + المشتري يوقّعان إنفاق التحرير (POST .../transitions, action: release)
// 7. المحرّك يدفع للبائع (POST /api/p2p/payments/payout)
// 8. الطرفان يريان الحالة COMPLETED على لوحة المعلومات
```

الفرق الجوهري عن Binance P2P: **لا زر "تأكيد" للبائع.** يُثبت الدفع عبر webhook من PayPal، وتجلس الأموال في سكربت 2-of-3 لا يتحكم فيه أي طرف وحده — حتمي، قابل للتدقيق، فوري.
