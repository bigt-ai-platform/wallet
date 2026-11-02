# P2P 结算状态机 — BIG → CNY

本文件是 P2P 结算流程的状态机说明（中文），可直接作为 Word 风格文档阅读或打印。状态名保留协议中的英文常量，括号内为中文含义；动作为中文。

## 状态流转（逐行）

```
ACTIVE（待撮合） ──撮合──▶ MATCHED（已匹配）
MATCHED（已匹配） ──锁定托管──▶ ESCROW_LOCKED（托管已锁定）
ESCROW_LOCKED（托管已锁定） ──付款说明──▶ PAYMENT_PENDING（待付款）
PAYMENT_PENDING（待付款） ──付款凭证──▶ PAYMENT_CLAIMED（已付款待确认）
PAYMENT_CLAIMED（已付款待确认） ──确认收款──▶ PAYMENT_VERIFIED（已确认收款）
PAYMENT_VERIFIED（已确认收款） ──卖方释放（引擎共同签名）──▶ ESCROW_RELEASED（托管已释放）
ESCROW_RELEASED（托管已释放） ──完成──▶ COMPLETED（已完成）
```

## 状态与动作

| 当前状态 | 动作（操作方） | 下一状态 | 说明 |
|---|---|---|---|
| `ACTIVE` 待撮合 | 撮合（买方） | `MATCHED` 已匹配 | 买方提供收款地址；引擎创建唯一 `swapId` 并推导 2-of-3 托管地址 |
| `MATCHED` 已匹配 | 锁定托管（卖方） | `ESCROW_LOCKED` 托管已锁定 | 卖方把 BIG 转入 2-of-3 地址；引擎验证链上锁定（`CONFIRMED`、目标、金额） |
| `ESCROW_LOCKED` 托管已锁定 | 付款说明（买方） | `PAYMENT_PENDING` 待付款 | 引擎只向已匹配的买方披露卖方的收款账户和每笔交易备注 |
| `PAYMENT_PENDING` 待付款 | 付款凭证（买方） | `PAYMENT_CLAIMED` 已付款待确认 | 买方在微信 / 支付宝 / 银行付款并提交流水号；代币仍然锁定 |
| `PAYMENT_CLAIMED` 已付款待确认 | 确认收款（卖方） | `PAYMENT_VERIFIED` 已确认收款 | 卖方在自己的账单核对金额 + 备注 + 时间 + 流水号 |
| `PAYMENT_VERIFIED` 已确认收款 | **释放（卖方；引擎共同签名）** | `ESCROW_RELEASED` 托管已释放 | 卖方应尽快点击「释放资金」；延迟释放会降低卖家评分，并可能被标记为不安全 |
| `ESCROW_RELEASED` 托管已释放 | 完成（引擎） | `COMPLETED` 已完成 | 交易关闭，买家持有代币 |

## 可选：争议裁决

| 当前状态 | 动作（操作方） | 结果 | 说明 |
|---|---|---|---|
| `PAYMENT_CLAIMED` / `PAYMENT_VERIFIED` | 争议（任一方） | 引擎 / 仲裁人 | 冻结交易；核对链上托管与付款证据 |
| 争议中 | 裁决（引擎 / 仲裁人） | `ESCROW_RELEASED` 或 `ESCROW_REFUNDED` | `release` 放币给买家；`refund` 退回卖方 |

## 动作对照

| 英文动作 | 中文 |
|---|---|
| `match` | 撮合 |
| `lock` | 锁定托管 |
| `instructions` | 付款说明 |
| `proof` | 付款凭证 |
| `confirm` | 确认收款 |
| `release` | 释放托管（卖方发起，引擎共同签名） |
| `complete` | 完成 |
| `dispute` | 争议（可选） |
| `dispute_resolve` | 争议裁决（释放或退款） |

## 重要规则

- **卖方应在确认收款后立即释放托管。** 延迟释放会计入卖家评分（确认→释放时长）；严重或反复延迟会把卖家标记为 **不安全（unsafe）**，影响后续订单。
- **设备核验（“Verify with my phone”）只由买家在卖家延迟释放时发起**；核验会记录到卖家的信誉中。卖家不应依赖设备核验，而应尽快执行 `release`。
- 每一步不可逆操作都由钱包自己的 PQ（ML-DSA）私钥签名；引擎只能共同签名一笔支出，从不持有用户资金，也从不触碰法币。
