# P2P निपटान — क्रॉस-रेल स्वैप, AI सत्यापन के साथ

**स्थिति: लक्ष्य डिज़ाइन, अभी निर्मित नहीं।** नीचे वह निपटान प्रवाह है जिसे हम बना रहे हैं: Bigtangle L0 पर 2-of-3 P2SH एस्क्रो और असली PayPal API सत्यापन। आज चलने वाला डेमो बिल्ड Postgres पर एक स्टेट मशीन है, जिसमें फ़िएट पक्ष मॉक किया गया है। स्क्रीनशॉट उसी डेमो बिल्ड से हैं; डिज़ाइन dai रिपोज़िटरी में `docs/p2p.md` में है।

यह गाइड AI-नेटिव P2P निपटान प्रवाह को दर्शाता है: USDT बेचने के लिए ऑर्डर, खरीदार द्वारा मैच, एस्क्रो लॉक, स्वचालित सत्यापन के साथ फ़िएट भुगतान, एस्क्रो रिलीज़ और समय-समाप्ति पर रिफ़ंड। कोई मैनुअल "पुष्टि" बटन नहीं — सेटलमेंट इंजन PayPal वेबहुक से भुगतान सत्यापित करता है।

---

## 1. डैशबोर्ड अवलोकन

P2P डैशबोर्ड सभी सक्रिय स्वैप की वर्तमान स्थिति, दर और लेनदेन संदर्भ दिखाता है।

![डैशबोर्ड](demo-output/screenshots/p2p-dashboard-hi.png)

डैशबोर्ड सभी सक्रिय स्वैप की स्थिति, दर और लेनदेन संदर्भ दिखाता है। प्रत्येक कार्ड स्वैप ID, संपत्ति जोड़ी (जैसे 100 USDT ⇄ 101 USD), रंग-कोडेड स्थिति बैज और विस्तार-योग्य टाइमलाइन दिखाता है।

---

## 2. विक्रेता USDT सूचीबद्ध करता है

सेटलमेंट इंजन को DID-हस्ताक्षरित सीमा ऑर्डर सबमिट करें।

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

विक्रेता हस्ताक्षरित सीमा ऑर्डर सबमिट करता है: 100 USDT के बदले $101 USD PayPal के माध्यम से। सेटलमेंट इंजन DID हस्ताक्षर सत्यापित करता है। स्थिति: ACTIVE। ऑर्डर validUntil के बाद समाप्त हो जाता है।

---

## 3. खरीदार ऑर्डर मैच करता है

खरीदार हस्ताक्षरित मार्केट ऑर्डर सबमिट करता है। दर मैच समय पर एक ओराकल द्वारा लॉक होती है, और इनवॉइस राशि इसी क्षण से तय हो जाती है।

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

खरीदार DID-हस्ताक्षरित मार्केट ऑर्डर से ऑर्डर मैच करता है, और वह पता देता है जिसे एस्क्रो रिलीज़ प्राप्त होनी है, साथ ही भुगतान के लिए PayPal खाता। स्थिति: MATCHED। पूरे जीवन-चक्र के लिए एक अद्वितीय swapId बनता है।

---

## 4. विक्रेता USDT को 2-of-3 एस्क्रो में लॉक करता है

एस्क्रो पता तीन कुंजियों वाला P2SH स्क्रिप्ट है — विक्रेता, खरीदार, इंजन — और थ्रेशोल्ड दो है।

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

विक्रेता Bigtangle L0 पर एस्क्रो पते को फंड करता है। इंजन `getTransactionStatus` से लॉक सिद्ध करता है — `CONFIRMED`, गंतव्य `escrowAddress`, राशि 100 — तीन में से कोई भी जाँच विफल होने पर फ़ेल-क्लोज़। स्थिति: ESCROW_LOCKED। खरीदार फ़िएट भेजने से पहले ही देखता है कि फंड सुरक्षित हैं।

---

## 5. इंजन इनवॉइस जारी करता है, खरीदार PayPal से भुगतान करता है

इंजन एक सटीक-राशि PayPal इनवॉइस बनाता है और होस्टेड URL खरीदार को सौंपता है।

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → होस्टेड चेकआउट URL; इनवॉइस नंबर = swapId
```

खरीदार होस्टेड इनवॉइस का भुगतान करता है। इंजन पैसे नहीं छूता — PayPal उन्हें रखता है। किसी विक्रेता की पुष्टि की आवश्यकता नहीं। स्थिति: PAYMENT_PENDING। समय-समाप्ति टाइमर शुरू होता है।

---

## 6. इंजन भुगतान स्वचालित रूप से सत्यापित करता है

**मुख्य नवाचार**: कोई मानव "पुष्टि" बटन नहीं। भुगतान किसी पक्ष द्वारा दावा नहीं, बल्कि PayPal द्वारा सिद्ध किया जाता है।

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

इंजन `INVOICING.INVOICE.PAID` वेबहुक सत्यापित करता है, `event.id` पर डीडुप्लिकेट। यह Binance P2P के मैनुअल "पुष्टि" बटन की जगह लेता है। कोई विक्रेता भुगतान न मिलने की झूठी बात नहीं कह सकता। स्थिति: PAYMENT_VERIFIED।

---

## 7. इंजन और खरीदार एस्क्रो रिलीज़ करते हैं

दो हस्ताक्षर स्क्रिप्ट को संतुष्ट करते हैं: खरीदार के और इंजन के। कोई एक पक्ष अकेले फंड नहीं ले जा सकता।

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

रिलीज़ खर्च असेंबल कर `receiveAddress` पर ब्रॉडकास्ट होता है। स्थिति: ESCROW_RELEASED। खरीदार के पास अब टोकन हैं; इंजन का शेष कार्य फ़िएट पेआउट है।

---

## 8. इंजन विक्रेता को भुगतान करता है

इंजन Payouts v1 के माध्यम से विक्रेता के PayPal में USD भेजता है, स्वैप पर इडेम्पोटेंट।

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

इंजन विक्रेता के PayPal में USD भेजता है। स्वैप COMPLETED। कुल समय ~3-5 मिनट। सब कुछ DID-हस्ताक्षरित, हर चरण चेन या PayPal पर ऑडिट-योग्य।

---

## 9. समय-समाप्ति या विफलता → रिफ़ंड

यदि इनवॉइस कभी भुगतान नहीं होता, तो इंजन और विक्रेता उसी स्क्रिप्ट पर सह-हस्ताक्षर कर विक्रेता को वापस भेजते हैं।

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

रिफ़ंड के लिए खरीदार की सहमति या टाइमलॉक की आवश्यकता नहीं — अन्य दो कुंजियों से थ्रेशोल्ड पूरा हो जाता है। स्थिति: EXPIRED → ESCROW_REFUNDED। कोई भी पक्ष कभी दूसरे के फंड नहीं रखता।

---

## 10. इतिहास दृश्य

पूर्ण, समाप्त और रद्द स्वैप इतिहास पृष्ठ पर दिखाई देते हैं।

![इतिहास](demo-output/screenshots/p2p-history-hi.png)

इतिहास पृष्ठ पूर्ण, समाप्त और रद्द स्वैप सूचीबद्ध करता है। प्रत्येक प्रविष्टि संपत्ति जोड़ी, अंतिम स्थिति, टाइमलाइन चरण और पक्षकार DIDs दिखाती है।

---

## तुलना: Binance P2P बनाम AI निपटान

| विशेषता | Binance P2P | AI निपटान |
|---------|-------------|---------------|
| फ़िएट सत्यापन | विक्रेता "पुष्टि" क्लिक करता है (सम्मान प्रणाली) | PayPal वेबहुक, RSA-सत्यापित (निश्चित) |
| फ़िएट कस्टडी | P2P (खरीदार → विक्रेता) | PayPal पेआउट तक रखता है (खरीदार → PayPal → विक्रेता) |
| एस्क्रो | आंतरिक लेजर | Bigtangle L0 पर 2-of-3 P2SH (सत्यापन-योग्य) |
| रिफ़ंड | सपोर्ट टिकट | इंजन + विक्रेता सह-हस्ताक्षर, खरीदार की सहमति नहीं |
| विवाद समाधान | मानव सपोर्ट (दिन) | चेन टूट प्रमाण + PayPal घटना (मिनट) |

---

## पूर्ण टाइमलाइन

```
MATCHED          14:20:00  दर लॉक, इनवॉइस राशि तय
ESCROW_LOCKED    14:23:15  L0 tx 2-of-3 पते पर CONFIRMED
PAYMENT_PENDING  14:24:00  इनवॉइस INV-7f3c91 जारी
PAYMENT_VERIFIED 14:24:10  INVOICING.INVOICE.PAID वेबहुक, RSA-सत्यापित
ESCROW_RELEASED  14:24:30  सह-हस्ताक्षरित खर्च receiveAddress को
COMPLETED        14:25:00  पेआउट बैच PAYOUT-abc SUCCESS
```

---

## पूर्ण डेमो प्रवाह

```typescript
// 1. विक्रेता हस्ताक्षरित सीमा ऑर्डर सबमिट करता है (POST /api/p2p/orders)
// 2. खरीदार हस्ताक्षरित मार्केट ऑर्डर से मैच करता है (POST /api/p2p/orders/:id/match)
// 3. विक्रेता L0 पर 2-of-3 P2SH एस्क्रो फंड करता है; इंजन सिद्ध करता है (getTransactionStatus)
// 4. इंजन PayPal इनवॉइस जारी करता है; खरीदार भुगतान करता है (POST /api/p2p/payments/invoice)
// 5. इंजन INVOICING.INVOICE.PAID वेबहुक सत्यापित करता है (POST /api/webhooks/paypal)
// 6. इंजन + खरीदार रिलीज़ खर्च सह-हस्ताक्षर करते हैं (POST .../transitions, action: release)
// 7. इंजन विक्रेता को पेआउट करता है (POST /api/p2p/payments/payout)
// 8. दोनों पक्ष डैशबोर्ड पर COMPLETED स्थिति देखते हैं
```

Binance P2P से मुख्य अंतर: **कोई विक्रेता "पुष्टि" बटन नहीं।** भुगतान PayPal वेबहुक द्वारा सिद्ध होता है, और फंड ऐसी 2-of-3 स्क्रिप्ट में बैठते हैं जिसे कोई एक पक्ष अकेले नियंत्रित नहीं कर सकता — निश्चित, ऑडिट-योग्य, तात्कालिक।
