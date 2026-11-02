# FIAT（法币）结算 — PayPal（USD / 美元）演示

**术语。** FIAT = 法币；USD = 美元；CNY = 人民币；`paypal` 是收款通道的协议名，App 中显示为 **PayPal**。

**状态：演示构建 + 仓库内引擎。** 与微信 / 支付宝 / 银行一样，PayPal 只是同一套 **2-of-3 P2SH 托管** 上的一条法币通道；区别是它报价 **USD**，收款账户是 PayPal 邮箱。个人 PayPal 转账同样没有机器可验证的支付事件，因此卖家在自己的 PayPal 账单上核对，然后由卖家释放托管。截图来自 **Android 应用真机** 的免资金演示构建（内存存储，无链上校验 — 锁定/释放哈希为合成）。设计见 `docs/p2p.md`。

本演示挂单出售 **BIG**（`bc`），买家以 **PayPal USD** 付款：

- 汇率：**BIG/USD = 0.01**
- 挂单：**10,000 BIG → 100 USD**
- 通道：`paypal`（在 App 中显示为 **PayPal**）

在 **P2P → 我的交换 → 发布卖单** 中选择 **PayPal** 时，法币会自动切换为 **USD**；选择微信 / 支付宝 / 银行时则自动为 **CNY**。

## 流程一览

```
ACTIVE（待撮合）
  ──撮合──▶ MATCHED（已匹配）
  ──锁定托管──▶ ESCROW_LOCKED（托管已锁定）
  ──付款说明──▶ PAYMENT_PENDING（待付款）
  ──付款凭证──▶ PAYMENT_CLAIMED（已付款待确认）
  ──确认收款──▶ PAYMENT_VERIFIED（已确认收款）
  ──卖方 release（引擎共同签名）──▶ ESCROW_RELEASED（托管已释放）
  ──完成──▶ COMPLETED（已完成）
```

可选路径：`PAYMENT_CLAIMED` / `PAYMENT_VERIFIED` ──争议──▶ 引擎协助裁决（`release` 或 `refund`）。

| # | 步骤 | 操作方 | 链上 / 引擎 |
|---|---|---|---|
| 1 | 卖家保存 PayPal 收款档案 | 卖方 | 仅存储，匹配后才披露 |
| 2 | 卖家挂单 BIG，报价 USD | 卖方 | `ACTIVE` |
| 3 | 买家撮合并提供收款地址 | 买方 | `MATCHED` |
| 4 | 卖家为 2-of-3 托管注资 | 卖方 | `ESCROW_LOCKED` |
| 5 | 买家拉取付款说明 | 买方 | `PAYMENT_PENDING` |
| 6 | 买家在 PayPal 付款，用交易号认领 | 买方 | `PAYMENT_CLAIMED` |
| 7 | 卖家在自己的 PayPal 账单确认 | 卖方 | `PAYMENT_VERIFIED` |
| 8 | **卖方释放代币**（引擎共同签名） | **卖方 + 引擎** | `ESCROW_RELEASED` → `COMPLETED` |
| 9 | *可选：* 争议由引擎协助裁决 | 引擎（仲裁） | `release` 或 `refund` |

---

## 1. 卖家保存 PayPal 收款档案

卖家打开 **P2P → 我的交换**，在通道中选择 **PayPal**，输入户名与 **PayPal 邮箱**。档案存储在服务器的卖家 DID 下，**不属于**公开订单簿 — 仅在匹配后向买家披露。

![卖家保存 PayPal 收款档案](assets/screenshots/p2p-paypal-01-profile-zh.png)

---

## 2. 卖家挂单 BIG（USD 报价）

向结算引擎提交 DID 签名的限价单：

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "bc", "giveAmount": "10000",
  "giveChain": "L0", "wantCurrency": "USD", "wantAmount": "100",
  "wantRail": "paypal", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

状态：`ACTIVE`；订单在 `validUntil` 后过期。

![以 paypal / USD 挂出卖单](assets/screenshots/p2p-paypal-02-order-zh.png)

---

## 3. 买家匹配订单

买家提交 DID 签名的匹配，并提供接收托管释放的地址。匹配时无需填写任何 PayPal 信息：

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

状态：`MATCHED`。为整个生命周期创建唯一的 `swapId`，2-of-3 托管地址由卖家 + 买家 + 引擎密钥推导。

![买家填写接收地址](assets/screenshots/p2p-paypal-03-match-zh.png)

![创建于 MATCHED 的交换](assets/screenshots/p2p-paypal-04-matched-zh.png)

---

## 4. 托管锁定 — 卖家为 L0 注资

卖家把 BIG 发送到确定性的 2-of-3 托管地址，并上报该笔转账的 `txHash`。引擎从链上证明锁定（`CONFIRMED`、目标为 `escrowAddress`、金额匹配），任一检查不通过则**失败即关闭**。

![卖家粘贴托管交易哈希](assets/screenshots/p2p-paypal-05-escrow-lock-zh.png)

交易此时为 `ESCROW_LOCKED`。买家在支付任何美元**之前**就能看到资金已被锁定，并获得一个 **付款详情** 操作：

![ESCROW_LOCKED](assets/screenshots/p2p-paypal-06-escrow-locked-zh.png)

---

## 5. 买家拉取支付说明

付款说明是引擎签名的，且只对已匹配的买家披露（PII 范围最小化）。它给出：

- 收款户名
- **PayPal 邮箱 / 账号**
- 精确金额 **100 USD**
- 每笔交易的**备注码**（remark）
- 支付截止时间

![PayPal 付款说明：户名、邮箱、100 USD、备注码](assets/screenshots/p2p-paypal-07-buy-locked-zh.png)

买家展开付款详情面板：

![付款详情面板](assets/screenshots/p2p-paypal-08-instructions-zh.png)

---

## 6. 买家在 PayPal 付款并用交易号认领

买家在自己的 PayPal 应用中转账 `100 USD`，在备注中填入备注码，然后把 PayPal 交易号粘贴到 **交易单号**，并按下 **我已付款**。可选的凭证图片存储在服务器端；只有其 `sha256` 被锚定到交换事件上。

![已输入交易号](assets/screenshots/p2p-paypal-09-payment-pending-zh.png)

状态：`PAYMENT_CLAIMED` — 代币仍处于锁定状态。此状态仅是买家的主张，仅此而已。

![PAYMENT_CLAIMED](assets/screenshots/p2p-paypal-10-payment-claimed-zh.png)

> **PayPal 提示。** 付款时请选择「商品和服务」并保留交易号；个人转账的备注不一定出现在对账单上，因此卖家核对时以 **金额 + 时间 + 交易号** 为准。

---

## 7. 卖家在自己的 PayPal 账单上确认

卖家的卡片显示买家的交易号。卖家只在 **自己的 PayPal 账单里确实看到这笔钱** 之后才点 **确认收到**：

![卖家核对交易号并确认](assets/screenshots/p2p-paypal-11-seller-confirm-zh.png)

状态：`PAYMENT_VERIFIED`。

---

## 8. 卖方释放托管（引擎共同签名）

> **卖家请尽快释放托管。** 确认收款后应立即执行「释放资金」；延迟释放会计入卖家评分（确认→释放时长），严重或多次延迟会把卖家标记为 **不安全（unsafe）**，影响后续订单。

**卖方在确认收款后应立即点击「释放资金」**；引擎共同签名后广播。代币到达买方的收款地址：

![PAYMENT_VERIFIED — 立即释放](assets/screenshots/p2p-paypal-12-payment-verified-zh.png)

![ESCROW_RELEASED — 托管已释放](assets/screenshots/p2p-paypal-13-escrow-released-zh.png)

由于卖方是直接收款的，因此没有法币出金步骤——交易就此完成：

![COMPLETED](assets/screenshots/p2p-paypal-14-completed-zh.png)

---

## 9. 可选：争议由引擎协助裁决

若买卖双方对付款有争议（金额不符、未收到款、卖家延迟释放等），任一方都可以冻结交易并提交争议。引擎（或部署中配置的仲裁人）核对链上托管与付款证据后，裁决为 `release`（放币给买家）或 `refund`（退回卖家）；裁决会锚定到交换记录。卖家的败诉与反复延迟会反映在信誉中，严重时可标记为 **不安全（unsafe）**。

---

## 为什么 PayPal 没有「用我的手机验证」

设备核验通过无障碍服务 / 通知读取本机支付应用；买家侧只有支付宝和银行有读取桥（微信只有收款方通知），而且只在卖家延迟释放或有争议时才会出现。**PayPal 没有该桥接**，因此 App 对 PayPal 交易只显示手动 **确认收到** 与 **申诉**，不显示 **「用我的手机验证」**（英文界面：Verify with my phone）。证据路径是：买家提交交易号 → 卖家在自己的 PayPal 账单核对 → 争议时由引擎 / 仲裁人裁决。

---

## 对比：Binance P2P 与本次结算

| | Binance P2P | 本次结算 |
|---|---|---|
| 托管 | 平台托管 | **链上 2-of-3 P2SH**（卖方 + 买方 + 引擎） |
| 法币确认 | 平台订单状态 | **卖家核对 PayPal 账单**，买家提供交易号 |
| 争议 | 平台客服裁决 | 引擎 / 仲裁人裁决，结果锚定 |
| 支付方式 | 多通道 | 微信 / 支付宝 / 银行（CNY）· **PayPal（USD）** |

---

## 完整演示流程

```bash
# 1. 免资金演示：本地引擎（内存存储、无链客户端），合成锁定/释放哈希
SETTLEMENT_STORE=mem SETTLEMENT_FIAT_RAILS=paypal \
  node services/p2p-engine/dist/server.bundle.mjs

# 2. 在 Android 演示应用中截取 PayPal 流程
RAIL=paypal CURRENCY=USD PREFIX=p2p-paypal \
  SELLER_ACCOUNT=seller@paypal.example BUYER_ACCOUNT=buyer@paypal.example \
  node e2e/capture-p2p-android-cny.mjs

# 3. 渲染移动版 PDF（390×844，语言跟随钱包 UI）
DOCS_PDF_MOBILE=1 npx tsx scripts/docs-pdf.mts \
  --md docs/p2p-demo/p2p-paypal.zh.md \
  --out docs/p2p-demo/assets/p2p-paypal.zh.mobile.pdf --lang zh
```
