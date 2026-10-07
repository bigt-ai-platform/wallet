# P2P 정산 — AI 검증이 있는 교차 레일 스왑

**상태: 목표 설계, 아직 구축되지 않음.** 아래는 우리가 구축하고 있는 정산 흐름입니다: Bigtangle L0의 2-of-3 P2SH 에스크로와 실제 PayPal API 검증. 오늘 돌아가는 데모 빌드는 Postgres 위의 상태 기계이며, 법정화폐 단계는 모의 처리입니다. 스크린샷은 해당 데모 빌드에서 나온 것이고, 설계는 dai 저장소 `docs/p2p.md`에 있습니다.

이 가이드는 AI 네이티브 P2P 정산 흐름을 보여줍니다: USDT 판매 등록, 구매자 매칭, 에스크로 잠금, 자동 검증이 있는 법정화폐 지불, 에스크로 해제, 그리고 시간 초과 시 환불. 수동 "확인" 버튼 없음 — 정산 엔진이 PayPal 웹훅으로 지불을 검증합니다.

---

## 1. 대시보드 개요

P2P 대시보드는 모든 활성 스왑의 현재 상태, 환율, 거래 참조를 보여줍니다.

![대시보드](demo-output/screenshots/p2p-dashboard-ko.png)

대시보드는 상태, 환율, 거래 참조가 담긴 모든 활성 스왑을 보여줍니다. 각 카드에는 스왑 ID, 자산 쌍(예: 100 USDT ⇄ 101 USD), 색상 코딩된 상태 배지, 펼칠 수 있는 타임라인이 표시됩니다.

---

## 2. 판매자가 USDT 등록

정산 엔진에 DID 서명된 지정가 주문을 제출합니다.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

판매자는 서명된 지정가 주문을 제출합니다: 100 USDT를 PayPal로 101달러에 판매. 정산 엔진이 DID 서명을 검증합니다. 상태: ACTIVE. 주문은 validUntil 후 만료됩니다.

---

## 3. 구매자가 주문 매칭

구매자는 서명된 시장가 주문을 제출합니다. 환율은 매칭 시점에 오라클로 잠기고, 청구서 금액은 그 순간 고정됩니다.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

구매자는 DID 서명된 시장가 주문으로 주문을 매칭하며, 에스크로 해제를 받을 주소와 지불할 PayPal 계정을 제공합니다. 상태: MATCHED. 전체 수명주기를 위한 고유 swapId가 생성됩니다.

---

## 4. 판매자가 USDT를 2-of-3 에스크로에 잠금

에스크로 주소는 세 키 — 판매자, 구매자, 엔진 — 를 가진 P2SH 스크립트이며 임계값은 2입니다.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

판매자가 Bigtangle L0의 에스크로 주소에 자금을 넣습니다. 엔진은 `getTransactionStatus`로 잠금을 증명합니다 — `CONFIRMED`, 목적지 `escrowAddress`, 금액 100 — 세 검사 중 하나라도 실패하면 실패 종료됩니다. 상태: ESCROW_LOCKED. 구매자는 법정화폐를 보내기 전에 자금이 보호된 것을 확인합니다.

---

## 5. 엔진이 청구서 발행, 구매자가 PayPal로 지불

엔진은 정확한 금액의 PayPal 청구서를 만들고 호스팅 URL을 구매자에게 넘깁니다.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → 호스팅 체크아웃 URL; 청구서 번호 = swapId
```

구매자가 호스팅된 청구서를 지불합니다. 엔진은 돈을 만지지 않습니다 — PayPal이 보유합니다. 판매자 확인 불필요. 상태: PAYMENT_PENDING. 시간 초과 타이머가 시작됩니다.

---

## 6. 엔진이 지불을 자동 검증

**핵심 혁신**: 사람의 "확인" 버튼이 없습니다. 지불은 당사자가 주장하지 않고 PayPal이 증명합니다.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

엔진은 `INVOICING.INVOICE.PAID` 웹훅을 `event.id`로 중복 제거하며 검증합니다. 이는 Binance P2P의 수동 "확인" 버튼을 대체합니다. 어떤 판매자도 수령하지 못했다고 거짓말할 수 없습니다. 상태: PAYMENT_VERIFIED.

---

## 7. 엔진과 구매자가 에스크로 해제

두 서명이 스크립트를 충족합니다: 구매자의 것과 엔진의 것. 어떤 한쪽도 자금을 단독으로 움직일 수 없습니다.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

해제 지출이 조립되어 `receiveAddress`로 브로드캐스트됩니다. 상태: ESCROW_RELEASED. 구매자가 토큰을 보유하게 되며, 엔진의 남은 일은 법정화료 지급입니다.

---

## 8. 엔진이 판매자에게 지급

엔진은 Payouts v1로 판매자의 PayPal에 USD를 보내며, 스왑 단위로 멱등합니다.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

엔진이 판매자의 PayPal에 USD를 보냅니다. 스왑 COMPLETED. 총 소요 시간: 약 3-5분. 모든 단계가 DID 서명이며, 각 단계는 온체인 또는 PayPal에서 감사 가능합니다.

---

## 9. 시간 초과 또는 실패 → 환불

청구서가 지불되지 않으면 엔진과 판매자가 같은 스크립트에 공동 서명해 판매자에게 돌려보냅니다.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

환불에는 구매자 동의나 타임락이 필요 없습니다 — 다른 두 키로 임계값에 도달합니다. 상태: EXPIRED → ESCROW_REFUNDED. 어느 쪽도 상대의 자금을 갖지 않습니다.

---

## 10. 기록 보기

완료, 만료, 취소된 스왑은 기록 페이지에 표시됩니다.

![기록](demo-output/screenshots/p2p-history-ko.png)

기록 페이지는 완료, 만료, 취소된 스왑을 나열합니다. 각 항목은 자산 쌍, 최종 상태, 타임라인 단계, 당사자 DID를 보여줍니다.

---

## 비교: Binance P2P vs AI 정산

| 기능 | Binance P2P | AI 정산 |
|---------|-------------|---------------|
| 법정화폐 검증 | 판매자가 "확인" 클릭 (명예 시스템) | PayPal 웹훅, RSA 검증 (결정적) |
| 법정화폐 보관 | P2P (구매자 → 판매자) | PayPal이 지급까지 보유 (구매자 → PayPal → 판매자) |
| 에스크로 | 내부 원장 | Bigtangle L0의 2-of-3 P2SH (검증 가능) |
| 환불 | 지원 티켓 | 엔진 + 판매자 공동 서명, 구매자 동의 불필요 |
| 분쟁 해결 | 사람 지원 (수일) | 온체인 트랜잭션 증거 + PayPal 이벤트 (수분) |

---

## 전체 타임라인

```
MATCHED          14:20:00  환율 잠금, 청구서 금액 고정
ESCROW_LOCKED    14:23:15  L0 tx가 2-of-3 주소에서 CONFIRMED
PAYMENT_PENDING  14:24:00  청구서 INV-7f3c91 발행
PAYMENT_VERIFIED 14:24:10  INVOICING.INVOICE.PAID 웹훅, RSA 검증
ESCROW_RELEASED  14:24:30  공동 서명 지출로 receiveAddress
COMPLETED        14:25:00  지급 배치 PAYOUT-abc SUCCESS
```

---

## 전체 데모 흐름

```typescript
// 1. 판매자가 서명된 지정가 주문 제출 (POST /api/p2p/orders)
// 2. 구매자가 서명된 시장가 주문으로 매칭 (POST /api/p2p/orders/:id/match)
// 3. 판매자가 L0의 2-of-3 P2SH 에스크로에 자금 투입; 엔진이 증명 (getTransactionStatus)
// 4. 엔진이 PayPal 청구서 발행; 구매자가 지불 (POST /api/p2p/payments/invoice)
// 5. 엔진이 INVOICING.INVOICE.PAID 웹훅 검증 (POST /api/webhooks/paypal)
// 6. 엔진 + 구매자가 해제 지출 공동 서명 (POST .../transitions, action: release)
// 7. 엔진이 판매자에게 지급 (POST /api/p2p/payments/payout)
// 8. 양쪽이 대시보드에서 COMPLETED 상태 확인
```

Binance P2P와의 핵심 차이: **판매자의 "확인" 버튼 없음.** 지불은 PayPal 웹훅으로 증명되고, 자금은 어느 쪽도 단독으로 통제할 수 없는 2-of-3 스크립트에 있습니다 — 결정적이고, 감사 가능하며, 즉시 완료됩니다.
