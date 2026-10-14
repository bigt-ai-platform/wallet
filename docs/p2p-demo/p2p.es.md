# Liquidación P2P — Swap de CNY con liberación confirmada por el vendedor

**Estado: build de demostración + motor en el repositorio.** Todo lo que sigue es el flujo de liquidación tal como está construido: depósito en garantía P2SH de 2-de-3 en Bigtangle L0 y una pata CNY confirmada por el vendedor (WeChat Pay / Alipay / banco). Una transferencia personal no tiene un evento de pago verificable por máquina, así que el propio extracto del vendedor es la señal fiat. Las capturas son del build de demostración (almacén en memoria, sin comprobación de cadena — los hashes de bloqueo/liberación son sintéticos). El diseño vive en `docs/p2p.md`.

Esta guía recorre la publicación de USDT en venta, el emparejamiento con un comprador, el bloqueo del depósito, el pago de CNY del comprador **directamente** al vendedor, la confirmación del vendedor en su propio extracto, la liberación del depósito y el reembolso por tiempo agotado.

Para el recorrido combinado de tres raíles (WeChat / Alipay / banco) véase [p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf`.

---

## 1. El vendedor guarda un perfil de cobro

El vendedor abre **P2P → Mis swaps**, elige el raíl (`wechat`) e introduce el nombre y la cuenta de 收款. El perfil se almacena en el servidor bajo el DID del vendedor y **no** forma parte del libro público de órdenes — solo se revela al comprador emparejado.

![El vendedor guarda el perfil de pago de WeChat](assets/screenshots/p2p-cny-wechat-01-profile-es.png)

---

## 2. El vendedor publica USDT

Envía una orden limitada firmada con DID al motor de liquidación:

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

La orden se valida contra la firma DID del vendedor. Estado: `ACTIVE`; caduca tras `validUntil`.

![Publicar una orden de venta con wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-es.png)

---

## 3. El comprador empareja la orden

El comprador envía un emparejamiento firmado con DID, indicando la dirección que debe recibir la liberación del depósito. No hay cuenta/correo que recoger — nada sobre el raíl fiat es necesario en el momento del emparejamiento:

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

Estado: `MATCHED`. Se crea un `swapId` único para el ciclo de vida y la dirección de depósito 2-de-3 se deriva de las claves vendedor + comprador + motor.

![El comprador rellena la dirección de recepción](assets/screenshots/p2p-cny-wechat-03-match-es.png)

![Swap creado en MATCHED](assets/screenshots/p2p-cny-wechat-04-matched-es.png)

---

## 4. El vendedor bloquea USDT en el depósito de 2-de-3

La dirección de depósito es un script P2SH con tres claves — vendedor, comprador, motor — y un umbral de dos:

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

El motor demuestra el bloqueo con `getTransactionStatus` — `CONFIRMED`, destino `escrowAddress`, importe 10 — y falla en modo cerrado si alguna comprobación no se cumple. Estado: `ESCROW_LOCKED`. El comprador ve los fondos asegurados antes de pagar.

![El vendedor pega el hash de la tx de depósito](assets/screenshots/p2p-cny-wechat-05-escrow-lock-es.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-es.png)

---

## 5. El comprador obtiene las instrucciones de pago

El comprador pulsa **Detalles de pago**. El motor revela el perfil del vendedor más un **concepto por swap** que la transferencia *debe* llevar, el importe exacto y una fecha límite:

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

Estado: `PAYMENT_PENDING`. Arranca un temporizador — un swap impagado puede expirar y reembolsarse sin el consentimiento del comprador.

![Instrucciones de pago: 户名, cuenta, 715 CNY, concepto](assets/screenshots/p2p-cny-wechat-08-instructions-es.png)

---

## 6. El comprador paga CNY y reclama con el 流水号

El comprador transfiere `715 CNY` en su propia app de WeChat, pega el número de transacción (流水号) en **Transaction ID** y pulsa **He pagado**. La imagen de recibo opcional se almacena en el servidor; solo su `sha256` se ancla al evento del swap.

![Número de transacción (流水号) introducido](assets/screenshots/p2p-cny-wechat-09-payment-pending-es.png)

Estado: `PAYMENT_CLAIMED` — los tokens siguen bloqueados. Este estado es la reclamación del comprador y nada más.

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-es.png)

---

## 7. El vendedor confirma en su propio extracto

La tarjeta del vendedor muestra el 流水号 del comprador y el concepto. El vendedor comprueba **importe + concepto + hora + 流水号 en su propia cuenta** (las capturas nunca cuentan) y solo entonces pulsa **Confirmar recepción**:

![El vendedor ve el 流水号 + la advertencia de confirmación](assets/screenshots/p2p-cny-wechat-11-seller-confirm-es.png)

Estado: `PAYMENT_VERIFIED`.

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-es.png)

---

## 8. El motor y el vendedor liberan el depósito

Dos firmas satisfacen el script: la del vendedor (prefirmada en el bloqueo, o una cofirma) y la del motor. Ninguna parte por sí sola puede mover los fondos.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

El gasto de liberación se ensambla y se emite hacia `receiveAddress`. Estado: `ESCROW_RELEASED`. El comprador ya tiene los tokens; como el vendedor ya cobró en CNY, no hay paso de pago fiat — `complete` cierra el swap.

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-es.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-es.png)

---

## 9. Tiempo agotado o fallo → reembolso

Si el comprador nunca paga, el motor y el vendedor cosignan el mismo script de vuelta al vendedor:

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

El reembolso no requiere consentimiento del comprador ni bloqueo temporal — el umbral se alcanza con las otras dos claves. Estado: `EXPIRED` → `ESCROW_REFUNDED`. Ninguna parte retiene nunca los fondos de la otra.

---

## 10. Verificación en el dispositivo — el propio teléfono del vendedor

El extracto del propio vendedor es el recibo; el motor puede leerlo
automáticamente a través de la app del teléfono
([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp)).
WeChat oculta su interfaz a la accesibilidad, así que para WeChat la app lee la
notificación «收款到账» (para Alipay/banco, la pantalla).

El emparejamiento es un **código corto de un solo uso** que la app muestra en su
pantalla Servidor: introduce el endpoint y el código en la pantalla **Dispositivo**
de la cartera (**Emparejar con código**) o en la página **Mobile** de dai — la app
devuelve un token por dispositivo (`POST /pair/claim`); se revoca en Ajustes ›
Acceso › Dispositivos emparejados.

Con `SETTLEMENT_CNY_AUTO_RELEASE_ON=seller_receipt`, el motor puede confirmar
automáticamente sin el toque manual.

## Comparativa: Binance P2P vs esta liquidación

| Función | Binance P2P | Esta liquidación |
|---|---|---|
| Verificación fiat | El vendedor pulsa «Confirmar» (sistema de honor) | El vendedor confirma en su propio extracto; el motor impone el protocolo |
| Custodia fiat | P2P (comprador → vendedor) | P2P (comprador → vendedor) — el motor nunca toca el fiat |
| Depósito | Libro interno | P2SH de 2-de-3 en Bigtangle L0 (verificable) |
| Reembolso | Ticket de soporte | Motor + vendedor cosignan, sin consentimiento del comprador |
| Resolución de disputas | Soporte humano (días) | Prueba de tx en cadena + almacén de pruebas + concepto por swap (minutos) |

---

## Línea de tiempo completa

```
MATCHED          14:20:00  Importe fijado en el emparejamiento
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMED en la dirección de 2-de-3
PAYMENT_PENDING  14:24:00  instrucciones emitidas (cuenta + concepto f71ade2d23e9)
PAYMENT_CLAIMED  14:25:10  el comprador pegó el 流水号 4200001234567890
PAYMENT_VERIFIED 14:26:40  el vendedor confirmó en su propio extracto de WeChat
ESCROW_RELEASED  14:27:20  vendedor + motor cosignaron el gasto hacia receiveAddress
COMPLETED        14:27:21  sin pago fiat — el vendedor ya tiene los CNY
```

---

## Flujo completo de la demostración

```typescript
// 1. El vendedor guarda un perfil de cobro en CNY     (POST /profiles)
// 2. El vendedor envía una orden limitada firmada     (POST /orders)
// 3. El comprador empareja con un match firmado       (POST /orders/:id/match)
// 4. El vendedor financia el depósito P2SH 2-de-3 en L0; el motor lo demuestra (escrow_lock)
// 5. El comprador obtiene las instrucciones de pago   (POST /swaps/:id/payment-instructions)
// 6. El comprador paga en WeChat y reclama el 流水号   (POST /swaps/:id/proof)
// 7. El vendedor confirma en su propio extracto       (POST /swaps/:id/confirm)
// 8. Vendedor + motor cosignan la liberación          (POST /swaps/:id/transitions, action: release)
// 9. El motor completa el swap                        (…/transitions, action: complete)
```

Diferencia clave con Binance P2P: los fondos reposan en un script 2-de-3 que ninguna parte controla por sí sola, cada transición se ancla en L1-SOCIAL y el propio extracto del vendedor — no un ticket de soporte — es la verdad fiat.
