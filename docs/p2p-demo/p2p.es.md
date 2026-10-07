# Liquidación P2P — Swap entre rails con verificación IA

**Estado: diseño objetivo, sin construir.** Todo lo que sigue describe el flujo de liquidación que estamos construyendo: depósito en garantía P2SH de 2-de-3 en Bigtangle L0 y verificación real contra la API de PayPal. La versión de demostración actual es una máquina de estados sobre Postgres con la pata fiat simulada. Las capturas son de esa versión; el diseño vive en el repositorio dai, `docs/p2p.md`.

Esta guía demuestra el flujo de liquidación P2P nativo de IA: publicar USDT en venta, emparejar con un comprador, bloqueo del depósito, pago fiat con verificación automática, liberación del depósito y reembolso por tiempo agotado. Sin botón manual de «Confirmar» — el Motor de Liquidación verifica el pago mediante un webhook de PayPal.

---

## 1. Vista del panel

El panel P2P muestra todos los swaps activos con su estado, tasa y referencias de transacción.

![Panel](demo-output/screenshots/p2p-dashboard-es.png)

El panel muestra todos los swaps activos con estado, tasa y referencias de transacción. Cada tarjeta muestra el ID del swap, el par de activos (p. ej. 100 USDT ⇄ 101 USD), una insignia de estado con código de colores y una línea de tiempo desplegable.

---

## 2. El vendedor publica USDT

Envía una orden limitada firmada con DID al Motor de Liquidación.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

El vendedor envía una orden limitada firmada: vender 100 USDT por 101 USD vía PayPal. El Motor de Liquidación valida la firma DID. Estado: ACTIVE. La orden caduca tras validUntil.

---

## 3. El comprador empareja la orden

El comprador envía una orden de mercado firmada. La tasa se fija al momento del emparejamiento mediante un oráculo, y el importe de la factura queda fijo desde ese instante.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

El comprador empareja la orden con una orden de mercado firmada con DID, indicando la dirección que debe recibir la liberación y la cuenta PayPal a abonar. Estado: MATCHED. Se crea un swapId único para el ciclo de vida.

---

## 4. El vendedor bloquea USDT en un depósito de 2-de-3

La dirección de depósito es un script P2SH con tres claves — vendedor, comprador, motor — y un umbral de dos.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

El vendedor financia la dirección de depósito en Bigtangle L0. El Motor demuestra el bloqueo con `getTransactionStatus` — `CONFIRMED`, destino `escrowAddress`, importe 100 — y falla en modo cerrado si cualquiera de las tres comprobaciones no se cumple. Estado: ESCROW_LOCKED. El comprador ve los fondos asegurados antes de enviar el fiat.

---

## 5. El Motor emite la factura, el comprador paga con PayPal

El Motor crea una factura PayPal de importe exacto y entrega la URL alojada al comprador.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → URL de pago alojada; número de factura = swapId
```

El comprador paga la factura alojada. El Motor no toca el dinero — PayPal lo retiene. No se necesita confirmación del vendedor. Estado: PAYMENT_PENDING. Arranca el temporizador de expiración.

---

## 6. El Motor verifica automáticamente el pago

**Innovación clave**: ningún botón humano de «Confirmar». El pago lo demuestra PayPal, no lo afirma una parte.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

El Motor verifica el webhook `INVOICING.INVOICE.PAID`, deduplicado por `event.id`. Esto sustituye al botón manual de «Confirmar» de Binance P2P. Ningún vendedor puede negar la recepción. Estado: PAYMENT_VERIFIED.

---

## 7. El Motor y el comprador liberan el depósito

Dos firmas satisfacen el script: la del comprador y la del motor. Ninguna parte por sí sola puede mover los fondos.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

El gasto de liberación se ensambla y se emite hacia `receiveAddress`. Estado: ESCROW_RELEASED. El comprador ya tiene los tokens; el trabajo restante del motor es el pago en fiat.

---

## 8. El Motor paga al vendedor

El Motor envía USD a la cuenta PayPal del vendedor mediante Payouts v1, de forma idempotente por swap.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

El Motor envía USD a la cuenta PayPal del vendedor. Swap COMPLETED. Tiempo total: ~3-5 minutos. Todo firmado con DID, cada paso auditable en cadena o en PayPal.

---

## 9. Tiempo agotado o fallo → reembolso

Si la factura nunca se paga, el motor y el vendedor cosignan el mismo script de vuelta al vendedor.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

El reembolso no requiere consentimiento del comprador ni un bloqueo temporal — el umbral se alcanza con las otras dos claves. Estado: EXPIRED → ESCROW_REFUNDED. Ninguna parte retiene nunca los fondos de la otra.

---

## 10. Vista de historial

Los swaps completados, expirados y cancelados se ven en la página de historial.

![Historial](demo-output/screenshots/p2p-history-es.png)

La página de historial lista los swaps completados, expirados y cancelados. Cada entrada muestra el par de activos, el estado final, los pasos de la línea de tiempo y los DID de las partes.

---

## Comparativa: Binance P2P vs liquidación IA

| Función | Binance P2P | Liquidación IA |
|---------|-------------|---------------|
| Verificación fiat | El vendedor pulsa «Confirmar» (honor) | Webhook de PayPal, verificado con RSA (determinista) |
| Custodia fiat | P2P (comprador → vendedor) | PayPal retiene hasta el pago (comprador → PayPal → vendedor) |
| Depósito | Libro interno | P2SH de 2-de-3 en Bigtangle L0 (verificable) |
| Reembolso | Ticket de soporte | Motor + vendedor cosignan, sin consentimiento del comprador |
| Resolución de disputas | Soporte humano (días) | Prueba de transacción en cadena + evento PayPal (minutos) |

---

## Línea de tiempo completa

```
MATCHED          14:20:00  Tasa fijada, importe de factura fijo
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMED en la dirección de 2-de-3
PAYMENT_PENDING  14:24:00  Factura INV-7f3c91 emitida
PAYMENT_VERIFIED 14:24:10  Webhook INVOICING.INVOICE.PAID, verificado con RSA
ESCROW_RELEASED  14:24:30  Gasto cosignado hacia receiveAddress
COMPLETED        14:25:00  Lote de pago PAYOUT-abc SUCCESS
```

---

## Flujo completo de la demostración

```typescript
// 1. El vendedor envía orden limitada firmada (POST /api/p2p/orders)
// 2. El comprador empareja con orden de mercado firmada (POST /api/p2p/orders/:id/match)
// 3. El vendedor financia el depósito P2SH de 2-de-3 en L0; el motor lo demuestra (getTransactionStatus)
// 4. El Motor emite factura PayPal; el comprador paga (POST /api/p2p/payments/invoice)
// 5. El Motor verifica el webhook INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. Motor + comprador cosignan el gasto de liberación (POST .../transitions, action: release)
// 7. El Motor paga al vendedor (POST /api/p2p/payments/payout)
// 8. Ambas partes ven el estado COMPLETED en el panel
```

Diferencia clave con Binance P2P: **sin botón de «Confirmar» del vendedor.** El pago lo demuestra un webhook de PayPal y los fondos residen en un script de 2-de-3 que ninguna parte controla por sí sola — determinista, auditable, instantáneo.
