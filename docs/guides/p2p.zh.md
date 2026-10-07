# P2P 结算 — 跨轨资产交换与 AI 自动验证

**状态：目标设计，尚未构建。** 下文描述我们正在构建的结算流程：Bigtangle L0 上的 2-of-3 P2SH 托管，以及真实的 PayPal API 验证。今天运行的演示版本是 Postgres 上的状态机，法币环节为模拟。截图来自该演示版本；设计见 dai 仓库的 `docs/p2p.md`。

本指南演示 AI 原生 P2P 结算流程：挂单出售 USDT、买家匹配、托管锁定、法币支付与自动验证、托管释放以及超时退款。无需手动"确认"按钮 — 结算引擎通过 PayPal Webhook 验证付款。

---

## 1. 仪表板概览

P2P 仪表板显示所有活跃交换的当前状态、汇率和交易参考。

![仪表板](demo-output/screenshots/p2p-dashboard-zh.png)

仪表板显示所有活跃交换的状态、汇率和交易参考。每张卡片显示交换ID、资产对（如 100 USDT ⇄ 101 USD）、颜色编码状态徽章和可展开时间线。

---

## 2. 卖家挂单 USDT

向结算引擎提交 DID 签名的限价单。

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

卖家提交签名限价单：以 101 美元出售 100 USDT（通过 PayPal）。结算引擎验证 DID 签名。状态：ACTIVE。订单在 validUntil 后过期。

---

## 3. 买家匹配订单

买家提交签名的市价单。汇率在匹配时通过预言机锁定，发票金额自此固定。

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

买家使用 DID 签名的市价单匹配订单，并提供接收托管释放的地址与收款 PayPal 账户。状态：MATCHED。为整个生命周期创建唯一 swapId。

---

## 4. 卖家将 USDT 锁定到 2-of-3 托管

托管地址是一个 P2SH 脚本，包含三个密钥 — 卖家、买家、引擎 — 阈值为二。

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

卖家为 Bigtangle L0 上的托管地址注资。引擎用 `getTransactionStatus` 证明锁定 — `CONFIRMED`、目标 `escrowAddress`、金额 100 — 三项检查有任何一项不成立即失败关闭。状态：ESCROW_LOCKED。买家在发送法币前即看到资金已受保护。

---

## 5. 引擎签发发票，买家通过 PayPal 付款

引擎创建精确金额的 PayPal 发票，并将托管页面 URL 交给买家。

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → 托管结账 URL；发票号 = swapId
```

买家支付托管发票。引擎不经手资金 — 由 PayPal 持有。无需卖家确认。状态：PAYMENT_PENDING。超时计时开始。

---

## 6. 引擎自动验证付款

**关键创新**：没有人工"确认"按钮。付款由 PayPal 证明，而非由某一方声称。

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

引擎验证 `INVOICING.INVOICE.PAID` Webhook，按 `event.id` 去重。这取代了 Binance P2P 的手动"确认"按钮。卖家无法谎称未收到款。状态：PAYMENT_VERIFIED。

---

## 7. 引擎与买家释放托管

两个签名即可满足脚本：买家的和引擎的。任何单一一方都无法动用资金。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

释放交易被组装并广播到 `receiveAddress`。状态：ESCROW_RELEASED。买家此时已持有代币；引擎剩余的工作是法币打款。

---

## 8. 引擎向卖家付款

引擎通过 Payouts v1 向卖家 PayPal 发送 USD，对交换幂等。

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

引擎向卖家 PayPal 发送 USD。交换 COMPLETED。总耗时约 3-5 分钟。全程 DID 签名，每一步都可在链上或 PayPal 审计。

---

## 9. 超时或失败 → 退款

若发票始终未支付，引擎与卖家共同签署同一脚本，将资金退回卖家。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

退款无需买家同意，也无需时间锁 — 另外两个密钥即可达到阈值。状态：EXPIRED → ESCROW_REFUNDED。任何一方都不曾持有对方的资金。

---

## 10. 历史记录

已完成、已过期和已取消的交换显示在历史页面。

![历史](demo-output/screenshots/p2p-history-zh.png)

历史页面列出已完成、已过期和已取消的交换。每条记录显示资产对、最终状态、时间线步骤和参与方 DID。

---

## 对比：Binance P2P vs AI 结算

| 功能 | Binance P2P | AI 结算 |
|---------|-------------|---------------|
| 法币验证 | 卖家点击"确认"（信誉系统） | PayPal Webhook，RSA 验签（确定性） |
| 法币托管 | P2P（买家 → 卖家） | PayPal 持有至打款（买家 → PayPal → 卖家） |
| 托管 | 内部账本 | Bigtangle L0 上的 2-of-3 P2SH（可验证） |
| 退款 | 客服工单 | 引擎 + 卖家共同签署，无需买家同意 |
| 争议解决 | 人工客服（数天） | 链上交易证明 + PayPal 事件（数分钟） |

---

## 完整时间线

```
MATCHED          14:20:00  汇率锁定，发票金额固定
ESCROW_LOCKED    14:23:15  L0 交易在 2-of-3 地址 CONFIRMED
PAYMENT_PENDING  14:24:00  已签发发票 INV-7f3c91
PAYMENT_VERIFIED 14:24:10  INVOICING.INVOICE.PAID Webhook，RSA 验签
ESCROW_RELEASED  14:24:30  共同签署的支出到 receiveAddress
COMPLETED        14:25:00  打款批次 PAYOUT-abc SUCCESS
```

---

## 完整演示流程

```typescript
// 1. 卖家提交签名限价单（POST /api/p2p/orders）
// 2. 买家使用签名市价单匹配（POST /api/p2p/orders/:id/match）
// 3. 卖家在 L0 为 2-of-3 P2SH 托管注资；引擎验证（getTransactionStatus）
// 4. 引擎签发 PayPal 发票；买家付款（POST /api/p2p/payments/invoice）
// 5. 引擎验证 INVOICING.INVOICE.PAID Webhook（POST /api/webhooks/paypal）
// 6. 引擎 + 买家共同签署释放交易（POST .../transitions, action: release）
// 7. 引擎向卖家付款（POST /api/p2p/payments/payout）
// 8. 双方在仪表板看到 COMPLETED 状态
```

与 Binance P2P 的关键区别：**无需卖家"确认"按钮。** 付款由 PayPal Webhook 证明，资金位于任何一方都无法单独控制的 2-of-3 脚本中 — 确定性、可审计、即时完成。
