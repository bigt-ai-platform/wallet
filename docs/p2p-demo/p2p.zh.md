# P2P 结算 — 卖家确认释放的 CNY 兑换

**状态：演示构建 + 仓库内引擎。** 下文即已构建的结算流程：Bigtangle L0 上的 2-of-3 P2SH 托管，以及卖家确认的 CNY 环节（微信支付 / 支付宝 / 银行）。个人转账没有机器可验证的支付事件，因此卖家自己的对账单就是法币信号。截图来自演示构建（内存存储，无链上校验 — 锁定/释放哈希为合成）。设计见 `docs/p2p.md`。

本指南演示挂单出售 USDT、与买家匹配、托管锁定、买家**直接**向卖家支付 CNY、卖家在自己的对账单上确认、托管释放，以及超时退款。

三轨合并演示（微信 / 支付宝 / 银行）见 [p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf`。

---

## 1. 卖家保存收款档案

卖家打开 **P2P → 我的交换**，选择通道（`wechat`）并输入收款名称和账户。该档案存储在服务器的卖家 DID 下，**不属于**公开订单簿 — 仅在匹配后向买家披露。

![卖家保存微信支付档案](assets/screenshots/p2p-cny-wechat-01-profile-zh.png)

---

## 2. 卖家挂单 USDT

向结算引擎提交 DID 签名的限价单：

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

订单将验证卖家的 DID 签名。状态：`ACTIVE`；订单在 `validUntil` 后过期。

![以 wechat / CNY 挂出卖单](assets/screenshots/p2p-cny-wechat-02-order-zh.png)

---

## 3. 买家匹配订单

买家提交 DID 签名的匹配，并提供接收托管释放的地址。没有账户/邮箱需要填写 — 匹配时无需任何法币通道信息：

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

状态：`MATCHED`。为整个生命周期创建唯一的 `swapId`，2-of-3 托管地址由卖家 + 买家 + 引擎密钥推导。

![买家填写接收地址](assets/screenshots/p2p-cny-wechat-03-match-zh.png)

![创建于 MATCHED 的交换](assets/screenshots/p2p-cny-wechat-04-matched-zh.png)

---

## 4. 卖家将 USDT 锁定到 2-of-3 托管

托管地址是一个含三个密钥的 P2SH 脚本 — 卖家、买家、引擎 — 阈值为二：

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

引擎用 `getTransactionStatus` 证明锁定 — `CONFIRMED`、目标 `escrowAddress`、金额 10 — 任何一项检查不成立即失败关闭。状态：`ESCROW_LOCKED`。买家在付款前看到资金已受保护。

![卖家粘贴托管交易哈希](assets/screenshots/p2p-cny-wechat-05-escrow-lock-zh.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-zh.png)

---

## 5. 买家拉取支付说明

买家按下 **支付详情**。引擎披露卖家档案，以及转账*必须*携带的**每笔交换备注**、精确金额和截止时间：

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

状态：`PAYMENT_PENDING`。超时计时开始 — 未支付的交换可在无需买家同意的情况下过期并退款。

![支付说明：户名、账户、715 CNY、备注](assets/screenshots/p2p-cny-wechat-08-instructions-zh.png)

---

## 6. 买家支付 CNY 并用流水号认领

买家在自己的微信应用中转账 `715 CNY`，将交易号（流水号）粘贴到 **Transaction ID**，并按下 **我已付款**。可选的凭证图片存储在服务器端；只有其 `sha256` 被锚定到交换事件上。

![已输入交易号（流水号）](assets/screenshots/p2p-cny-wechat-09-payment-pending-zh.png)

状态：`PAYMENT_CLAIMED` — 代币仍处于锁定状态。此状态仅是买家的主张，仅此而已。

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-zh.png)

---

## 7. 卖家在自己的对账单上确认

卖家的卡片显示买家的流水号和备注。卖家在自己的账户中核对**金额 + 备注 + 时间 + 流水号**（截图一律不算数），然后才按下 **确认收款**：

![卖家看到流水号 + 确认警告](assets/screenshots/p2p-cny-wechat-11-seller-confirm-zh.png)

状态：`PAYMENT_VERIFIED`。

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-zh.png)

---

## 8. 引擎与卖家释放托管

两个签名即可满足脚本：卖家的（锁定时预签名，或共同签署）和引擎的。任何单一一方都无法动用资金。

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

释放交易被组装并广播到 `receiveAddress`。状态：`ESCROW_RELEASED`。买家持有代币；由于卖家已收到 CNY，不存在法币打款步骤 — `complete` 关闭交换。

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-zh.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-zh.png)

---

## 9. 超时或失败 → 退款

若买家始终未付款，引擎与卖家共同签署同一脚本退回卖家：

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

退款无需买家同意，也无需时间锁 — 另外两个密钥即可达到阈值。状态：`EXPIRED` → `ESCROW_REFUNDED`。任何一方都不曾持有对方的资金。

---

## 对比：Binance P2P 与本次结算

| 功能 | Binance P2P | 本次结算 |
|---|---|---|
| 法币验证 | 卖家点击"确认"（信誉系统） | 卖家在自己的对账单上确认；引擎强制执行协议 |
| 法币托管 | P2P（买家 → 卖家） | P2P（买家 → 卖家）— 引擎从不经手法币 |
| 托管 | 内部账本 | Bigtangle L0 上的 2-of-3 P2SH（可验证） |
| 退款 | 客服工单 | 引擎 + 卖家共同签署，无需买家同意 |
| 争议解决 | 人工客服（数天） | 链上交易证明 + 证明存储 + 每笔交换备注（数分钟） |

---

## 完整时间线

```
MATCHED          14:20:00  金额在匹配时固定
ESCROW_LOCKED    14:23:15  L0 交易在 2-of-3 地址 CONFIRMED
PAYMENT_PENDING  14:24:00  已下发说明（账户 + 备注 f71ade2d23e9）
PAYMENT_CLAIMED  14:25:10  买家粘贴流水号 4200001234567890
PAYMENT_VERIFIED 14:26:40  卖家在自己的微信对账单上确认
ESCROW_RELEASED  14:27:20  卖家 + 引擎共同签署支出到 receiveAddress
COMPLETED        14:27:21  无法币打款 — 卖家已持有 CNY
```

---

## 完整演示流程

```typescript
// 1. 卖家保存 CNY 收款档案                 (POST /profiles)
// 2. 卖家提交签名限价单                   (POST /orders)
// 3. 买家使用签名匹配                     (POST /orders/:id/match)
// 4. 卖家在 L0 为 2-of-3 P2SH 托管注资；引擎证明（escrow_lock）
// 5. 买家拉取支付说明                     (POST /swaps/:id/payment-instructions)
// 6. 买家在微信付款并认领流水号           (POST /swaps/:id/proof)
// 7. 卖家在自己的对账单上确认             (POST /swaps/:id/confirm)
// 8. 卖家 + 引擎共同签署释放              (POST /swaps/:id/transitions, action: release)
// 9. 引擎完成交换                         (…/transitions, action: complete)
```

与 Binance P2P 的关键区别：资金存放于任何一方都无法单独控制的 2-of-3 脚本中，每次状态转移都锚定在 L1-SOCIAL 上，而卖家自己的对账单 — 而非客服工单 — 才是法币事实。
