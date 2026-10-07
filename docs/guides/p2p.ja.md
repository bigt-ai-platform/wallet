# P2P セットルメント — AI 検証によるチェーン横断スワップ

**ステータス: 目標設計、未構築。** 以下は私たちが構築しているセットルメントフローです — Bigtangle L0 上の 2-of-3 P2SH エスクローと、実際の PayPal API による検証。現在稼働中のデモ版は Postgres 上のステートマシンで、法定通貨側はモックです。スクリーンショットはそのデモ版のもので、設計は dai リポジトリの `docs/p2p.md` にあります。

このガイドは AI ネイティブ P2P セットルメントフローを示します — USDT の出品、買い手とのマッチング、エスクローロック、自動検証付きの法定通貨支払い、エスクロー解放、そしてタイムアウト時の返金。手動の「確認」ボタンはありません — セットルメントエンジンは PayPal Webhook から支払いを検証します。

---

## 1. ダッシュボード概要

P2P ダッシュボードは、すべてのアクティブなスワップの現在のステータス、レート、取引参照を表示します。

![ダッシュボード](demo-output/screenshots/p2p-dashboard-ja.png)

ダッシュボードはすべてのアクティブなスワップをステータス、レート、取引参照とともに表示します。各カードにはスワップ ID、資産ペア（例: 100 USDT ⇄ 101 USD）、色分けされたステータスバッジ、展開可能なタイムラインが表示されます。

---

## 2. セラーが USDT を出品

DID 署名付きの指値注文をセットルメントエンジンへ送信します。

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

セラーは署名済みの指値注文を送信します: 100 USDT を PayPal 経由で 101 USD で売る。セットルメントエンジンは DID 署名を検証します。ステータス: ACTIVE。注文は validUntil で期限切れになります。

---

## 3. 買い手が注文をマッチング

買い手は署名済みの成行注文を送信します。レートはマッチング時にオラクルで固定され、その時点から請求額が確定します。

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

買い手は DID 署名付きの成行注文でマッチングし、エスクロー解放の受取アドレスと入金先 PayPal アカウントを指定します。ステータス: MATCHED。ライフサイクル全体用の一意な swapId が作成されます。

---

## 4. セラーが 2-of-3 エスクローに USDT をロック

エスクローアドレスは 3 つの鍵 — セラー、買い手、エンジン — と閾値 2 の P2SH スクリプトです。

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

セラーは Bigtangle L0 上のエスクローアドレスに資金を投入します。エンジンは `getTransactionStatus` でロックを証明します — `CONFIRMED`、送信先 `escrowAddress`、金額 100 — 3 つの検証のいずれかが成立しなければフェイルクローズします。ステータス: ESCROW_LOCKED。買い手は法定通貨を送る前に資金が確保されているのを確認できます。

---

## 5. エンジンが請求書を発行、買い手が PayPal で支払う

エンジンは正確な金額の PayPal 請求書を作成し、ホスト型 URL を買い手に渡します。

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → ホスト型チェックアウト URL; 請求書番号 = swapId
```

買い手はホスト型請求書を支払います。エンジンはお金に触れません — PayPal が預かります。セラーの確認は不要です。ステータス: PAYMENT_PENDING。タイムアウトタイマーが開始します。

---

## 6. エンジンが支払いを自動検証

**主要な革新**: 人手の「確認」ボタンはありません。支払いは当事者の主張ではなく PayPal が証明します。

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

エンジンは `INVOICING.INVOICE.PAID` Webhook を `event.id` で重複排除しながら検証します。これは Binance P2P の手動「確認」ボタンを置き換えます。セラーは受領しなかったと嘘をつけません。ステータス: PAYMENT_VERIFIED。

---

## 7. エンジンと買い手がエスクローを解放

2 つの署名がスクリプトを満たします — 買い手の署名とエンジンの署名。単独の当事者は資金を動かせません。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

解放用の支出を組み立てて `receiveAddress` にブロードキャストします。ステータス: ESCROW_RELEASED。買い手はトークンを保持し、エンジンの残作業は法定通貨の送金です。

---

## 8. エンジンがセラーに支払う

エンジンは Payouts v1 でセラーの PayPal に USD を送金し、スワップ単位で冪等です。

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

エンジンはセラーの PayPal に USD を送金します。スワップは COMPLETED。合計所要時間は約 3〜5 分。すべて DID 署名で、各ステップはオンチェーンまたは PayPal で監査できます。

---

## 9. タイムアウトまたは失敗 → 返金

請求書が支払われない場合、エンジンとセラーは同じスクリプトに共同署名してセラーへ戻します。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

返金には買い手の同意もタイムロックも不要です — 残り 2 つの鍵で閾値に達します。ステータス: EXPIRED → ESCROW_REFUNDED。どちらの当事者も相手方の資金を保持しません。

---

## 10. 履歴表示

完了・期限切れ・キャンセルされたスワップは履歴ページで確認できます。

![履歴](demo-output/screenshots/p2p-history-ja.png)

履歴ページには完了・期限切れ・キャンセルされたスワップが一覧表示されます。各エントリには資産ペア、最終ステータス、タイムラインの各段階、当事者の DID が表示されます。

---

## 比較: Binance P2P vs AI セットルメント

| 機能 | Binance P2P | AI セットルメント |
|---------|-------------|---------------|
| 法定通貨の検証 | セラーが「確認」をクリック（ honor ベース） | PayPal Webhook、RSA 検証（決定的） |
| 法定通貨の預託 | P2P（買い手 → セラー） | PayPal が送金まで預かる（買い手 → PayPal → セラー） |
| エスクロー | 内部台帳 | Bigtangle L0 上の 2-of-3 P2SH（検証可能） |
| 返金 | サポートチケット | エンジン + セラーが共同署名、買い手の同意不要 |
| 紛争解決 | 人間のサポート（数日） | オンチェーンの取引証明 + PayPal イベント（数分） |

---

## 完全なタイムライン

```
MATCHED          14:20:00  レート固定、請求額確定
ESCROW_LOCKED    14:23:15  L0 トランザクションが 2-of-3 アドレスで CONFIRMED
PAYMENT_PENDING  14:24:00  請求書 INV-7f3c91 を発行
PAYMENT_VERIFIED 14:24:10  INVOICING.INVOICE.PAID Webhook、RSA 検証済み
ESCROW_RELEASED  14:24:30  receiveAddress への共同署名の支出
COMPLETED        14:25:00  支払いバッチ PAYOUT-abc SUCCESS
```

---

## 完全なデモフロー

```typescript
// 1. セラーが署名済み指値注文を送信（POST /api/p2p/orders）
// 2. 買い手が署名済み成行注文でマッチング（POST /api/p2p/orders/:id/match）
// 3. セラーが L0 の 2-of-3 P2SH エスクローに投入; エンジンが検証（getTransactionStatus）
// 4. エンジンが PayPal 請求書を発行; 買い手が支払い（POST /api/p2p/payments/invoice）
// 5. エンジンが INVOICING.INVOICE.PAID Webhook を検証（POST /api/webhooks/paypal）
// 6. エンジン + 買い手が解放支出に共同署名（POST .../transitions, action: release）
// 7. エンジンがセラーに支払い（POST /api/p2p/payments/payout）
// 8. 両者がダッシュボードで COMPLETED を確認
```

Binance P2P との最大の違い: **セラーの「確認」ボタンが不要。** 支払いは PayPal Webhook が証明し、資金は単独では制御できない 2-of-3 スクリプトにあります — 決定的、監査可能、即時。
