# Liquidación P2P — intercambio entre rieles nativo del wallet

**Qué es.** Un intercambio entre pares de cripto en **Bigtangle L0** y fiat en
**PayPal** (o los rieles CNY — WeChat Pay / Alipay / banco). El vendedor deposita
los tokens en una **dirección P2SH 2-de-3** (vendedor, comprador, motor); el
comprador paga una obligación fiat de **importe exacto**; el motor demuestra el
pago y libera el depósito. Cada paso irreversible se firma con la clave PQ del
wallet, y el motor solo puede **co-firmar** un gasto — nunca custodia tus fondos.

**Dónde.** La pantalla **P2P** del wallet (barra lateral → Trade → P2P). Todo lo
que sigue está capturado desde esa pantalla en la compilación de demostración
local.

**Demo vs. real.** Las capturas provienen de la demo: el motor funciona en modo
PayPal simulado (URL de factura y hashes de transacción sintéticos) y los pasos
lock/verify/release se firman con una clave de motor local. La máquina de estados,
las firmas, el registro de eventos de solo-anexado y el anclaje de auditoría
on-chain son reales; solo se simulan las llamadas externas a PayPal y la
difusión en L0.

**Sin «Confirmar» manual.** En el riel PayPal no hay botón de «Confirmar» del
vendedor — el motor verifica el pago a partir de su propia evidencia. (Los rieles
CNY, que no tienen webhook, usan en su lugar una confirmación explícita del
vendedor; ver `docs/p2pcny.md`.)

---

## El flujo de un vistazo

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Paso | Quién actúa | On-chain / motor |
|---|---|---|---|
| 1 | El vendedor publica una orden de venta firmada | vendedor | orden guardada, sin financiar |
| 2 | El comprador hace match (dirección de recepción + cuenta PayPal) | comprador | se crea `swapId`, se deriva la dirección de depósito |
| 3 | El vendedor financia el depósito 2-de-3, el motor prueba el bloqueo | vendedor + motor | `ESCROW_LOCKED` en L0 |
| 4 | El comprador paga la factura de importe exacto y la reporta | comprador | `PAYMENT_PENDING` |
| 5 | El motor verifica el pago por sí mismo | motor | `PAYMENT_VERIFIED` |
| 6 | Motor + comprador co-firman la liberación, los tokens se mueven | motor + comprador | `ESCROW_RELEASED` |
| 7 | El motor paga al vendedor vía PayPal Payouts | motor | `COMPLETED` |

Cada transición se ancla como un registro `social.p2p-swap` en la cadena
L1-SOCIAL, de modo que todo el ciclo de vida es auditable públicamente sin
exponer los datos de PayPal de ninguna parte.

---

## 1. El vendedor publica una orden de venta

En la pestaña **Open sells**, completa la orden: el token y la cantidad que
entregas, el precio fiat que quieres, la moneda, la cadena del token y el
**método de pago** (PayPal o un riel CNY). Los términos se fijan en la orden al
publicarla, así que esto se firma con la clave de tu wallet.

![El formulario de orden de venta, riel PayPal elegido](/demo/p2p/p2p-01-order-es.png)

Una vez publicada, la orden es `ACTIVE` en el motor y aparece en el libro de
órdenes público (sin datos personales):

![La orden está viva en el libro](/demo/p2p/p2p-02-active-es.png)

---

## 2. El comprador hace match

El comprador abre la orden y facilita la **dirección de recepción** de los tokens
liberados y la **cuenta PayPal** a la que facturar (y un correo para la factura).
El match compromete al comprador a pagar, así que también se firma:

![El comprador rellena la dirección de recepción y la cuenta PayPal](/demo/p2p/p2p-03-match-es.png)

El motor crea un `swapId` único para el ciclo de vida y el intercambio pasa a
`MATCHED`, visible en la pestaña **My swaps** del comprador:

![El intercambio está MATCHED](/demo/p2p/p2p-04-matched-es.png)

---

## 3. Bloqueo del depósito — el vendedor financia L0

El vendedor envía los tokens a la dirección de depósito determinista 2-de-3 y
reporta el `txHash` de la transferencia. El motor prueba el bloqueo desde la
cadena (`CONFIRMED`, destino `escrowAddress`, importe) y falla si alguna
comprobación no se cumple. El intercambio es ahora `ESCROW_LOCKED`:

![El vendedor bloquea el depósito](/demo/p2p/p2p-05-escrow-locked-es.png)

El comprador ve los fondos asegurados **antes** de enviar fiat alguno, y obtiene
una acción **I have paid** (He pagado) en cuanto se prueba el bloqueo:

![El comprador ve el depósito bloqueado](/demo/p2p/p2p-06-buyer-locked-es.png)

---

## 4. El comprador paga

El comprador paga la factura alojada de PayPal (PayPal custodia el dinero —
nunca el motor) y reporta el pago. Esto es solo una *pista*; la verificación real
es la evidencia propia del motor. El intercambio es `PAYMENT_PENDING`, y arranca
un temporizador de espera — si la factura nunca se paga, el vendedor puede
expirar y reembolsar el depósito sin el consentimiento del comprador:

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-es.png)

---

## 5. El motor verifica el pago

No interviene ninguna confirmación del vendedor. El motor comprueba el pago
desde su propia fuente y avanza el intercambio a `PAYMENT_VERIFIED` — el depósito
ya puede liberarse a la dirección de recepción del comprador:

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-es.png)

---

## 6. Liberación — los fondos se mueven

La liberación mueve los tokens depositados: el motor y el comprador firman cada
uno un gasto de la salida del depósito, y dos firmas satisfacen el script 2-de-3.
Los tokens llegan a la dirección de recepción del comprador y el intercambio es
`ESCROW_RELEASED`:

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-es.png)

---

## 7. Pago — el vendedor recibe el fiat

El último paso paga al vendedor mediante PayPal Payouts, y el intercambio llega a
`COMPLETED`:

![COMPLETED](/demo/p2p/p2p-10-completed-es.png)

El resultado del pago (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) llega por webhook
de PayPal o se consulta como respaldo; un fallo puede reintentarse desde
`COMPLETED` sin rehacer el intercambio.

---

## Qué te protege

| Riesgo | Mitigación |
|---|---|
| La contraparte se marcha | Los fondos están en una dirección P2SH 2-de-3; nadie puede moverlos solo |
| Pago de menos o de más | La factura es de importe exacto: se paga entera o queda sin pagar |
| Reclamación de pago falsa | El motor verifica el pago por sí mismo — el pagador no puede autoatribuírselo |
| Motor malicioso | Los pasos exclusivos del motor exigen la firma DID del motor; cada transición se ancla y es auditable públicamente |
| Contracargo tras la liberación | `PAYMENT.CAPTURE.REVERSED` activa un congelamiento: los pasos hacia delante se detienen, reembolso/expiración siguen disponibles |
| Disputa | `CUSTOMER.DISPUTE.*` pausa el intercambio hasta que se resuelva |
| Fallo de pago | `HELD`/`FAILED`/`BLOCKED` son estados de primer nivel; reintentar con la misma referencia de pago |

---

## Pasar a producción

La demo se ejecuta contra el servicio de liquidación del repositorio con PayPal
simulado. Para el flujo real necesitas una cuenta business de PayPal con Payouts
activados, sus credenciales API y su webhook id, y el firmante del depósito
conectado al paso de difusión en L0. Hasta entonces, el motor ejecuta la misma
máquina de estados sin tocar dinero real.
