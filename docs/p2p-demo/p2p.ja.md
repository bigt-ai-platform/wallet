# P2P セットルメント — セラー確認リリースによる CNY スワップ

**ステータス: デモビルド + リポジトリ内エンジン。** 以下はすべて、構築済みのセットルメントフローです — Bigtangle L0 上の 2-of-3 P2SH エスクローと、セラー確認済みの CNY レッグ（WeChat Pay / Alipay / 銀行）。個人送金には機械検証可能な支払いイベントがないため、セラー自身の明細が法定通貨のシグナルとなります。スクリーンショットはデモビルドのものです（メモリストア、チェーン検証なし — ロック/リリースのハッシュは合成）。設計は `docs/p2p.md` にあります。

このガイドでは、USDT の売り出し、買い手とのマッチング、エスクローロック、買い手が CNY をセラーへ**直接**支払うこと、セラーが自身の明細で確認すること、エスクローのリリース、そしてタイムアウト時の返金までを順に説明します。

3 レール統合のウォークスルー（WeChat / Alipay / 銀行）は [p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf` を参照。

---

## 1. セラーが收款プロフィールを保存

セラーは **P2P → マイスワップ** を開き、レール（`wechat`）を選び、收款名とアカウントを入力します。プロフィールはセラーの DID の下にサーバー側で保存され、公開注文板の一部では**ありません** — マッチした買い手だけに開示されます。

![セラーが WeChat 支払いプロフィールを保存](assets/screenshots/p2p-cny-wechat-01-profile-ja.png)

---

## 2. セラーが USDT を出品

DID 署名付きの指値注文をセットルメントエンジンへ送信します:

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

注文はセラーの DID 署名に対して検証されます。ステータス: `ACTIVE`。`validUntil` の後に期限切れになります。

![wechat / CNY の売り注文を掲載](assets/screenshots/p2p-cny-wechat-02-order-ja.png)

---

## 3. 買い手が注文をマッチング

買い手は DID 署名付きのマッチを送信し、エスクロー解放を受け取るアドレスを指定します。収集すべきアカウント/メールはありません — マッチ時点で法定通貨レールに関する情報は不要です:

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

ステータス: `MATCHED`。ライフサイクル用に一意な `swapId` が作成され、2-of-3 エスクローアドレスがセラー + 買い手 + エンジンの鍵から導出されます。

![買い手が受取アドレスを入力](assets/screenshots/p2p-cny-wechat-03-match-ja.png)

![MATCHED でスワップ作成](assets/screenshots/p2p-cny-wechat-04-matched-ja.png)

---

## 4. セラーが 2-of-3 エスクローに USDT をロック

エスクローアドレスは 3 つの鍵 — セラー、買い手、エンジン — と閾値 2 の P2SH スクリプトです:

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

エンジンは `getTransactionStatus` でロックを証明します — `CONFIRMED`、送信先 `escrowAddress`、金額 10 — いずれかの検証が成立しなければフェイルクローズします。ステータス: `ESCROW_LOCKED`。買い手は支払う前に資金が確保されているのを確認できます。

![セラーがエスクロー tx ハッシュを貼り付け](assets/screenshots/p2p-cny-wechat-05-escrow-lock-ja.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-ja.png)

---

## 5. 買い手が支払い指示を取得

買い手は **支払い詳細** を押します。エンジンはセラーのプロフィールに加え、送金が*必ず*記載しなければならない**スワップ単位の備考**、正確な金額、期限を開示します:

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

ステータス: `PAYMENT_PENDING`。タイムアウトが開始します — 未払いのスワップは買い手の同意なしに失効・返金できます。

![支払い指示: 户名、アカウント、715 CNY、備考](assets/screenshots/p2p-cny-wechat-08-instructions-ja.png)

---

## 6. 買い手が CNY を支払い、流水号で申請

買い手は自分の WeChat アプリで `715 CNY` を送金し、取引番号（流水号）を **Transaction ID** に貼り付けて **支払いました** を押します。任意の領収書画像はサーバー側に保存され、その `sha256` のみがスワップイベントにアンカーされます。

![取引番号（流水号）を入力](assets/screenshots/p2p-cny-wechat-09-payment-pending-ja.png)

ステータス: `PAYMENT_CLAIMED` — トークンはまだロックされたままです。この状態は買い手の主張にすぎません。

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-ja.png)

---

## 7. セラーが自身の明細で確認

セラーのカードには買い手の流水号と備考が表示されます。セラーは**自分の口座で金額 + 備考 + 時刻 + 流水号を確認**し（スクリーンショットは一切根拠になりません）、その後にのみ **受領を確認** を押します:

![セラーが流水号 + 確認の警告を表示](assets/screenshots/p2p-cny-wechat-11-seller-confirm-ja.png)

ステータス: `PAYMENT_VERIFIED`。

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-ja.png)

---

## 8. エンジンとセラーがエスクローを解放

2 つの署名がスクリプトを満たします — セラーの署名（ロック時に事前署名、または共同署名）とエンジンの署名。単独の当事者は資金を動かせません。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

解放用の支出を組み立てて `receiveAddress` にブロードキャストします。ステータス: `ESCROW_RELEASED`。買い手はトークンを保持し、セラーはすでに CNY で支払われているため、法定通貨の送金ステップはありません — `complete` がスワップを閉じます。

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-ja.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-ja.png)

---

## 9. タイムアウトまたは失敗 → 返金

買い手が支払わない場合、エンジンとセラーは同じスクリプトに共同署名してセラーへ戻します:

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

返金には買い手の同意もタイムロックも不要です — 残り 2 つの鍵で閾値に達します。ステータス: `EXPIRED` → `ESCROW_REFUNDED`。どちらの当事者も相手方の資金を保持しません。

---

## 比較: Binance P2P vs このセットルメント

| 機能 | Binance P2P | このセットルメント |
|---|---|---|
| 法定通貨の検証 | セラーが「確認」をクリック（信義ベース） | セラーが自身の明細で確認；エンジンがプロトコルを強制 |
| 法定通貨の預託 | P2P（買い手 → セラー） | P2P（買い手 → セラー）— エンジンは法定通貨に一切触れない |
| エスクロー | 内部台帳 | Bigtangle L0 上の 2-of-3 P2SH（検証可能） |
| 返金 | サポートチケット | エンジン + セラーが共同署名、買い手の同意不要 |
| 紛争解決 | 人間のサポート（数日） | オンチェーンの取引証明 + プルーフストア + スワップ単位の備考（数分） |

---

## 完全なタイムライン

```
MATCHED          14:20:00  マッチ時に金額を固定
ESCROW_LOCKED    14:23:15  L0 トランザクションが 2-of-3 アドレスで CONFIRMED
PAYMENT_PENDING  14:24:00  指示を発行（アカウント + 備考 f71ade2d23e9）
PAYMENT_CLAIMED  14:25:10  買い手が流水号 4200001234567890 を貼り付け
PAYMENT_VERIFIED 14:26:40  セラーが自身の WeChat 明細で確認
ESCROW_RELEASED  14:27:20  セラー + エンジンが receiveAddress への支出に共同署名
COMPLETED        14:27:21  法定通貨の送金なし — セラーはすでに CNY を保有
```

---

## 完全なデモフロー

```typescript
// 1. セラーが CNY 收款プロフィールを保存        (POST /profiles)
// 2. セラーが署名済み指値注文を送信             (POST /orders)
// 3. 買い手が署名済みマッチでマッチング         (POST /orders/:id/match)
// 4. セラーが L0 の 2-of-3 P2SH エスクローに投入；エンジンが証明（escrow_lock）
// 5. 買い手が支払い指示を取得                   (POST /swaps/:id/payment-instructions)
// 6. 買い手が WeChat で支払い流水号を申請       (POST /swaps/:id/proof)
// 7. セラーが自身の明細で確認                   (POST /swaps/:id/confirm)
// 8. セラー + エンジンが解放に共同署名          (POST /swaps/:id/transitions, action: release)
// 9. エンジンがスワップを完了                   (…/transitions, action: complete)
```

Binance P2P との最大の違い: 資金はどちらの当事者も単独では制御できない 2-of-3 スクリプトにあり、すべての状態遷移が L1-SOCIAL にアンカーされ、セラー自身の明細 — サポートチケットではなく — が法定通貨の真実です。
