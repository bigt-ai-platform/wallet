# Liquidación P2P — intercambio CNY nativo del wallet

**Qué es.** Un intercambio entre pares de cripto en **Bigtangle L0** y fiat CNY
(WeChat Pay / Alipay / banco). El vendedor deposita los tokens en una **dirección
P2SH 2-de-3** (vendedor, comprador, motor); el comprador paga al vendedor
**directamente** en su propia app de pago; el vendedor confirma la recepción en
su propio extracto y el depósito se libera. Cada paso irreversible se firma con
la clave PQ del wallet, y el motor solo puede **co-firmar** un gasto — nunca
custodia tus fondos ni toca el fiat.

**Dónde.** La pantalla **P2P** del wallet (barra lateral → Trade → P2P). Todo lo
que sigue está capturado desde esa pantalla en la compilación de demostración
local.

**Demo vs. real.** Las capturas provienen de la demo: el motor funciona con un
almacén en memoria y sin comprobación de cadena, así que las etapas lock/release
usan hashes de transacción sintéticos. La máquina de estados, las firmas, el
registro de eventos de solo-anexado y el anclaje de auditoría on-chain son
reales; solo se simula la difusión en L0.

**La confirmación del vendedor es la señal fiat.** No hay API de cobro para una
cuenta personal de WeChat/Alipay/banco, así que no hay ningún evento de pago
verificable por máquina que esperar. El vendedor comprueba **importe + concepto
+ hora + 流水号 en su propia app** — una captura de pantalla nunca cuenta — y
confirma. Los detalles de diseño están en `docs/p2p.md`.

---

## El flujo de un vistazo

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──instructions──▶ PAYMENT_PENDING
                                                                          │
   PAYMENT_PENDING ──proof──▶ PAYMENT_CLAIMED ──confirm──▶ PAYMENT_VERIFIED
                                                                  │
                            PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──complete──▶ COMPLETED
```

| # | Paso | Quién actúa | On-chain / motor |
|---|---|---|---|
| 1 | El vendedor guarda un perfil de cobro CNY | vendedor | perfil guardado en el servidor, nunca en el libro |
| 2 | El vendedor publica una orden de venta firmada | vendedor | orden guardada, sin financiar |
| 3 | El comprador hace match (dirección de recepción) | comprador | se crea `swapId`, se deriva la dirección de depósito |
| 4 | El vendedor financia el depósito 2-de-3, el motor prueba el bloqueo | vendedor + motor | `ESCROW_LOCKED` en L0 |
| 5 | El comprador obtiene las instrucciones de pago | comprador | `PAYMENT_PENDING` (+ concepto por intercambio) |
| 6 | El comprador paga en su propia app y reclama con el 流水号 | comprador | `PAYMENT_CLAIMED` |
| 7 | El vendedor comprueba su propio extracto y confirma | vendedor | `PAYMENT_VERIFIED` |
| 8 | El motor libera los tokens, el intercambio se completa | motor | `ESCROW_RELEASED` → `COMPLETED` |

Cada transición se ancla como un registro `social.p2p-swap` en la cadena
L1-SOCIAL, de modo que todo el ciclo de vida es auditable públicamente sin
exponer los datos de cuenta de ninguna de las partes.

---

## 1. El vendedor guarda un perfil de cobro

En la pestaña **My swaps**, el vendedor elige un riel (WeChat, Alipay o banco) e
introduce el nombre de 收款 y la cuenta. El perfil se guarda en el servidor bajo
el DID del vendedor y **no** forma parte del libro de órdenes público — solo se
revela al comprador emparejado mediante la llamada de instrucciones.

![El vendedor guarda el perfil de pago de WeChat](/demo/p2p/p2p-cny-wechat-01-profile-es.png)

---

## 2. El vendedor publica una orden de venta

En la pestaña **Open sells**, completa la orden: el token y la cantidad que
entregas, el precio en CNY que quieres, la cadena en la que están los tokens y el
**método de pago** (wechat / alipay / bank). Elegir un riel CNY cambia la moneda
a CNY. Los términos se fijan en la orden al publicarla, así que esto se firma con
la clave de tu wallet:

![El formulario de orden de venta con el riel wechat](/demo/p2p/p2p-cny-wechat-02-order-es.png)

Una vez publicada, la orden es `ACTIVE` en el motor y aparece en el libro de
órdenes público (no lleva ningún dato personal).

---

## 3. El comprador hace match

El comprador abre la orden y facilita la **dirección de recepción** de los tokens
liberados. El match compromete al comprador a pagar, así que también se firma:

![El comprador rellena la dirección de recepción](/demo/p2p/p2p-cny-wechat-03-match-es.png)

El motor crea un `swapId` único para el ciclo de vida y el intercambio pasa a
`MATCHED`, visible en la pestaña **My swaps** del comprador:

![El intercambio está MATCHED](/demo/p2p/p2p-cny-wechat-04-matched-es.png)

---

## 4. Bloqueo del depósito — el vendedor financia L0

El vendedor envía los tokens a la dirección de depósito determinista 2-de-3 y
reporta el `txHash` de la transferencia. El motor prueba el bloqueo desde la
cadena (`CONFIRMED`, destino `escrowAddress`, importe) y falla si alguna
comprobación no se cumple:

![El vendedor pega el hash de la transacción del depósito](/demo/p2p/p2p-cny-wechat-05-escrow-lock-es.png)

El intercambio es ahora `ESCROW_LOCKED`. El comprador ve los fondos asegurados
**antes** de enviar fiat alguno, y obtiene una acción **Payment details**
(Detalles del pago):

![ESCROW_LOCKED](/demo/p2p/p2p-cny-wechat-06-escrow-locked-es.png)

---

## 5. El comprador obtiene las instrucciones de pago

El comprador pulsa **Payment details** (Detalles del pago); el motor revela el
perfil del vendedor y acuña un **código de concepto por intercambio** que la
transferencia *debe* llevar, más el importe exacto y una fecha límite. Las
instrucciones se muestran en línea en la tarjeta del intercambio:

![Instrucciones de pago: 户名, cuenta, 715 CNY, concepto](/demo/p2p/p2p-cny-wechat-08-instructions-es.png)

El intercambio es `PAYMENT_PENDING`, y arranca un temporizador de espera — si el
comprador nunca paga, el vendedor puede expirar y reembolsar el depósito sin el
consentimiento del comprador.

---

## 6. El comprador paga y reclama con el 流水号

El comprador transfiere el importe exacto en su propia app de
WeChat/Alipay/banco, pega el número de transacción (流水号) en **Transaction ID**
y pulsa **I have paid** (He pagado). Una imagen de recibo opcional se guarda en
el servidor; solo su `sha256` se ancla en el evento del intercambio:

![Transaction ID (流水号) introducido](/demo/p2p/p2p-cny-wechat-09-payment-pending-es.png)

El estado es ahora `PAYMENT_CLAIMED` — **los tokens siguen bloqueados.** Este
estado existe puramente como la reclamación del comprador:

![PAYMENT_CLAIMED](/demo/p2p/p2p-cny-wechat-10-payment-claimed-es.png)

---

## 7. El vendedor confirma en su propio extracto

La tarjeta del vendedor muestra el 流水号 del comprador y el concepto. El
vendedor comprueba **importe + concepto + hora + 流水号 en su propia cuenta** y
solo entonces pulsa **Confirm received** (Confirmar recepción):

![El vendedor ve el 流水号 y el aviso de confirmación](/demo/p2p/p2p-cny-wechat-11-seller-confirm-es.png)

El intercambio es `PAYMENT_VERIFIED`:

![PAYMENT_VERIFIED](/demo/p2p/p2p-cny-wechat-12-payment-verified-es.png)

---

## 8. Liberación — los fondos se mueven

La liberación mueve los tokens depositados: el vendedor (prefirma o co-firma) y
el motor firman cada uno un gasto de la salida del depósito, y dos firmas
satisfacen el script 2-de-3. Los tokens llegan a la dirección de recepción del
comprador:

![ESCROW_RELEASED](/demo/p2p/p2p-cny-wechat-13-escrow-released-es.png)

Como el vendedor cobró directamente, no hay paso de pago fiat — el intercambio se
completa:

![COMPLETED](/demo/p2p/p2p-cny-wechat-14-completed-es.png)

---

## Qué te protege

| Riesgo | Mitigación |
|---|---|
| La contraparte se marcha | Los fondos están en una dirección P2SH 2-de-3; nadie puede moverlos solo |
| Pago de menos o de más | El importe se fija en el match; las instrucciones llevan la cifra exacta y un concepto por intercambio |
| Reclamación de pago falsa | La reclamación del comprador por sí sola nunca libera — el vendedor confirma en su propio extracto |
| El vendedor alega no recepción | Arbitraje; el registro de la cadena y el almacén de pruebas son la evidencia |
| Motor malicioso | Los pasos exclusivos del motor exigen la firma DID del motor; cada transición se ancla y es auditable públicamente |
| Disputa | Cualquiera de las partes congela el intercambio; los tokens permanecen bloqueados hasta que se resuelva |
| Reembolso | `expire` → `refund`, co-firmados por el motor y el vendedor — sin consentimiento del comprador, sin timelock |

---

## Pasar a producción

La demo se ejecuta contra el servicio de liquidación del repositorio con un
almacén en memoria y sin comprobación de cadena. El flujo real conecta el
firmante del depósito al paso de difusión en L0 y ejecuta el motor contra
L1-SOCIAL para el libro de órdenes y el anclaje de auditoría; el comprador paga
al vendedor directamente, y el motor sigue limitándose a co-firmar.
