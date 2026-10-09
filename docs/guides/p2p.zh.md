# P2P 结算 — 钱包原生的跨渠道兑换

**这是什么。** 在 **Bigtangle L0** 上的加密货币与 **PayPal**（或人民币渠道：微信支付 / 支付宝 / 银行）法币之间的点对点兑换。卖方将代币托管到一个 **2-of-3 P2SH 地址**（卖方、买方、引擎）；买方支付一笔**精确金额**的法币；引擎验证付款后释放托管。每一步不可逆操作都由钱包自己的 PQ 私钥签名，引擎只能**共同签名**一笔支出——它从不持有你的资金。

**在哪里。** 钱包中的 **P2P** 页面（侧边栏 → 交易 → P2P）。以下所有截图都取自本地演示构建的该页面。

**演示与线上。** 截图来自演示构建：引擎运行在模拟 PayPal 模式（伪造的发票 URL 和合成的交易哈希），锁定/验证/释放步骤由本地引擎密钥签名。状态机、签名、只追加事件日志以及链上审计锚定都是真实的；只有对外的 PayPal 调用和 L0 广播被替换为桩实现。

**没有手动“确认”。** PayPal 渠道上没有卖方“确认”按钮——引擎根据自身的证据验证付款。（人民币渠道没有 webhook，改用卖方的显式确认；参见 `docs/p2pcny.md`。）

---

## 流程一览

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | 步骤 | 操作方 | 链上 / 引擎 |
|---|---|---|---|
| 1 | 卖方挂出签名的卖单 | 卖方 | 订单入库，尚未注资 |
| 2 | 买方撮合（收款地址 + PayPal 账户） | 买方 | 创建 `swapId`，推导托管地址 |
| 3 | 卖方为 2-of-3 托管注资，引擎证明锁定 | 卖方 + 引擎 | L0 上 `ESCROW_LOCKED` |
| 4 | 买方支付精确金额发票并上报 | 买方 | `PAYMENT_PENDING` |
| 5 | 引擎自行验证付款 | 引擎 | `PAYMENT_VERIFIED` |
| 6 | 引擎 + 买方共同签名释放，代币转移 | 引擎 + 买方 | `ESCROW_RELEASED` |
| 7 | 引擎通过 PayPal Payouts 向卖方付款 | 引擎 | `COMPLETED` |

每次状态转换都会作为一条 `social.p2p-swap` 记录锚定到 L1-SOCIAL 链上，因此整个生命周期都可公开审计，同时不暴露任何一方的 PayPal 信息。

---

## 1. 卖方挂出卖单

在 **Open sells（卖单）** 标签页填写订单：你给出的代币与数量、你想要的法币价格、币种、代币所在的链，以及**支付方式**（PayPal 或人民币渠道）。条款在挂单时即被锁定，因此这一步用你的钱包密钥签名。

![卖单表单，已选择 PayPal 渠道](/demo/p2p/p2p-01-order-zh.png)

挂出后，订单在引擎中为 `ACTIVE`，并出现在公开订单簿中（订单不包含任何个人资料）：

![订单位于订单簿中](/demo/p2p/p2p-02-active-zh.png)

---

## 2. 买方撮合

买方打开订单，提供用于接收释放代币的**收款地址**，以及发票应账单的 **PayPal 账户**（并填写接收发票的邮箱）。撮合意味着买方承诺付款，因此这一步同样需要签名：

![买方填写收款地址与 PayPal 账户](/demo/p2p/p2p-03-match-zh.png)

引擎为该生命周期创建一个唯一的 `swapId`，交易进入 `MATCHED`，显示在买方的 **My swaps（我的交易）** 标签页：

![交易为 MATCHED](/demo/p2p/p2p-04-matched-zh.png)

---

## 3. 托管锁定 — 卖方为 L0 注资

卖方把代币发送到确定性的 2-of-3 托管地址，并上报该笔转账的 `txHash`。引擎从链上证明锁定（`CONFIRMED`、目标为 `escrowAddress`、金额匹配），任一检查不通过则**失败即关闭**。交易此时为 `ESCROW_LOCKED`：

![卖方锁定托管](/demo/p2p/p2p-05-escrow-locked-zh.png)

买方在发送任何法币**之前**就能看到资金已被锁定，并在锁定被证明后获得一个 **I have paid（我已付款）** 操作：

![买方看到已锁定的托管](/demo/p2p/p2p-06-buyer-locked-zh.png)

---

## 4. 买方付款

买方支付 PayPal 托管的发票（钱由 PayPal 代管——引擎从不经手），并上报该笔付款。这只是一个*提示*；真正的验证来自引擎自身的证据。交易为 `PAYMENT_PENDING`，并启动一个超时计时器——若发票始终未支付，卖方无需买方同意即可让其过期并退还托管：

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-zh.png)

---

## 5. 引擎验证付款

此步骤不涉及卖方确认。引擎根据自己的来源核验付款，并将交易推进到 `PAYMENT_VERIFIED`——托管此刻已可释放到买方的收款地址：

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-zh.png)

---

## 6. 释放 — 资金转移

释放会移动托管的代币：引擎与买方各签名一笔托管输出的支出，两个签名即可满足 2-of-3 脚本。代币到达买方的收款地址，交易为 `ESCROW_RELEASED`：

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-zh.png)

---

## 7. 出金 — 卖方拿到法币

最后一步通过 PayPal Payouts 向卖方付款，交易达到 `COMPLETED`：

![COMPLETED](/demo/p2p/p2p-10-completed-zh.png)

出金结果（`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`）来自 PayPal 的 webhook，或以轮询作为后备；失败可从 `COMPLETED` 重试，而无需重做整笔交易。

---

## 什么在保护你

| 风险 | 缓解措施 |
|---|---|
| 对手方走人 | 资金存放在 2-of-3 P2SH 地址中；任何一方都无法单独移动 |
| 少付或多付 | 发票为精确金额，要么全额支付，要么保持未付 |
| 伪造付款声明 | 引擎自行验证付款——付款方无法自行断言 |
| 引擎作恶 | 仅引擎可执行的步骤需要引擎 DID 签名；每次转换都被锚定且可公开审计 |
| 释放后拒付 | `PAYMENT.CAPTURE.REVERSED` 触发冻结：前进步骤停止，退款/过期仍可执行 |
| 争议 | `CUSTOMER.DISPUTE.*` 暂停交易直至解决 |
| 出金失败 | `HELD`/`FAILED`/`BLOCKED` 是一等状态；使用相同的出金参考号重试 |

---

## 上线运行

演示运行在仓库内、使用模拟 PayPal 的结算服务上。要运行真实流程，你需要一个已开通 Payouts 的 PayPal 商业账户、其 API 凭据与 webhook id，并将托管签名器接入 L0 广播步骤。在此之前，引擎运行相同的状态机，但不触碰真实资金。
