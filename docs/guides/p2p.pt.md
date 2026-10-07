# P2P de Liquidação — Troca Inter-Rota com Verificação por IA

**Status: design alvo, ainda não construído.** Abaixo está o fluxo de liquidação que estamos construindo: escrow P2SH de 2 de 3 no Bigtangle L0 e verificação real da API do PayPal. A build de demonstração que roda hoje é uma máquina de estados sobre Postgres com a perna fiduciária simulada. As capturas de tela são dessa build de demonstração; o design fica no repositório dai, `docs/p2p.md`.

Este guia demonstra o fluxo de liquidação P2P nativo de IA: listar USDT à venda, correspondência com um comprador, bloqueio do escrow, pagamento fiduciário com verificação automática, liberação do escrow e reembolso por tempo esgotado. Sem botão manual de "Confirmar" — o Mecanismo de Liquidação verifica o pagamento a partir de um webhook do PayPal.

---

## 1. Visão Geral do Painel

O painel P2P mostra todas as trocas ativas com o status atual, a taxa e as referências das transações.

![Painel](demo-output/screenshots/p2p-dashboard-pt.png)

O painel mostra todas as trocas ativas com status, taxa e referências de transação. Cada cartão exibe o ID da troca, o par de ativos (ex.: 100 USDT ⇄ 101 USD), o selo de status com código de cores e a linha do tempo expansível.

---

## 2. O Vendedor Lista USDT

Envie uma ordem limitada assinada por DID ao Mecanismo de Liquidação.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

O vendedor envia uma ordem limitada assinada: vender 100 USDT por 101 USD via PayPal. O Mecanismo de Liquidação valida a assinatura do DID. Status: ACTIVE. A ordem expira após validUntil.

---

## 3. O Comprador Corresponde à Ordem

O comprador envia uma ordem de mercado assinada. A taxa é travada no momento da correspondência via um oráculo, e o valor da fatura é fixado a partir desse instante.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

O comprador corresponde à ordem com uma ordem de mercado assinada por DID, fornecendo o endereço que deve receber a liberação do escrow e a conta PayPal a ser paga. Status: MATCHED. Um swapId exclusivo é criado para o ciclo de vida.

---

## 4. O Vendedor Trava USDT no Escrow de 2 de 3

O endereço do escrow é um script P2SH com três chaves — vendedor, comprador, mecanismo — e um limiar de dois.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

O vendedor financia o endereço do escrow no Bigtangle L0. O Mecanismo prova o bloqueio com `getTransactionStatus` — `CONFIRMED`, destino `escrowAddress`, valor 100 — e falha fechada se qualquer uma das três verificações não se sustentar. Status: ESCROW_LOCKED. O comprador vê os fundos assegurados antes de enviar o dinheiro.

---

## 5. O Mecanismo Emite a Fatura, o Comprador Paga via PayPal

O Mecanismo cria uma fatura PayPal de valor exato e entrega a URL hospedada ao comprador.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → URL de checkout hospedada; número da fatura = swapId
```

O comprador paga a fatura hospedada. O Mecanismo não toca no dinheiro — o PayPal o retém. Nenhuma confirmação do vendedor necessária. Status: PAYMENT_PENDING. O cronômetro de tempo esgotado começa.

---

## 6. O Mecanismo Verifica o Pagamento Automaticamente

**Inovação principal**: nenhum botão humano de "Confirmar". O pagamento é provado pelo PayPal, não alegado por uma parte.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

O Mecanismo verifica o webhook `INVOICING.INVOICE.PAID`, deduplicado em `event.id`. Isso substitui o botão manual de "Confirmar" do Binance P2P. Nenhum vendedor pode mentir sobre o não recebimento. Status: PAYMENT_VERIFIED.

---

## 7. O Mecanismo e o Comprador Liberam o Escrow

Duas assinaturas satisfazem o script: a do comprador e a do mecanismo. Nenhuma parte isolada pode mover os fundos.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

O gasto de liberação é montado e transmitido para `receiveAddress`. Status: ESCROW_RELEASED. O comprador agora detém os tokens; o trabalho restante do mecanismo é o pagamento fiduciário.

---

## 8. O Mecanismo Paga o Vendedor

O Mecanismo envia USD para o PayPal do vendedor via Payouts v1, idempotente por troca.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

O Mecanismo envia USD para o PayPal do vendedor. Troca COMPLETED. Tempo total: ~3-5 minutos. Tudo assinado por DID, cada passo auditável na cadeia ou no PayPal.

---

## 9. Tempo Esgotado ou Falha → Reembolso

Se a fatura nunca for paga, o mecanismo e o vendedor assinam conjuntamente o mesmo script de volta ao vendedor.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

O reembolso não exige consentimento do comprador nem timelock — o limiar é atingido com as outras duas chaves. Status: EXPIRED → ESCROW_REFUNDED. Nenhuma parte detém os fundos da outra.

---

## 10. Visão de Histórico

Trocas concluídas, expiradas e canceladas ficam visíveis na página de histórico.

![Histórico](demo-output/screenshots/p2p-history-pt.png)

A página de histórico lista as trocas concluídas, expiradas e canceladas. Cada entrada mostra o par de ativos, o status final, as etapas da linha do tempo e os DIDs das partes.

---

## Comparação: Binance P2P vs Liquidação por IA

| Recurso | Binance P2P | Liquidação por IA |
|---------|-------------|---------------|
| Verificação fiduciária | Vendedor clica em "Confirmar" (sistema de honra) | Webhook do PayPal, verificado por RSA (determinístico) |
| Custódia fiduciária | P2P (comprador → vendedor) | PayPal retém até o pagamento (comprador → PayPal → vendedor) |
| Escrow | Ledger interno | P2SH de 2 de 3 no Bigtangle L0 (verificável) |
| Reembolso | Ticket de suporte | Mecanismo + vendedor assinam conjuntamente, sem consentimento do comprador |
| Resolução de disputas | Suporte humano (dias) | Prova on-chain + evento PayPal (minutos) |

---

## Linha do Tempo Completa

```
MATCHED          14:20:00  Taxa travada, valor da fatura fixado
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMADA no endereço de 2 de 3
PAYMENT_PENDING  14:24:00  Fatura INV-7f3c91 emitida
PAYMENT_VERIFIED 14:24:10  Webhook INVOICING.INVOICE.PAID, verificado por RSA
ESCROW_RELEASED  14:24:30  Gasto co-assinado para receiveAddress
COMPLETED        14:25:00  Lote de pagamento PAYOUT-abc SUCCESS
```

---

## Fluxo Completo da Demonstração

```typescript
// 1. Vendedor envia ordem limitada assinada (POST /api/p2p/orders)
// 2. Comprador corresponde com ordem de mercado assinada (POST /api/p2p/orders/:id/match)
// 3. Vendedor financia o escrow P2SH de 2 de 3 no L0; mecanismo prova (getTransactionStatus)
// 4. Mecanismo emite fatura PayPal; comprador paga (POST /api/p2p/payments/invoice)
// 5. Mecanismo verifica webhook INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. Mecanismo + comprador co-assinam o gasto de liberação (POST .../transitions, action: release)
// 7. Mecanismo paga o vendedor (POST /api/p2p/payments/payout)
// 8. Ambas as partes veem o status COMPLETED no painel
```

Diferença fundamental do Binance P2P: **sem botão de "Confirmar" do vendedor.** O pagamento é provado por um webhook do PayPal e os fundos ficam num script de 2 de 3 que nenhuma parte controla sozinha — determinístico, auditável, instantâneo.
