# Liquidación FIAT (moneda fiduciaria) — Cambia BIG por WeChat / Alipay / banco o PayPal

**Terminología.** FIAT = moneda fiduciaria; CNY = yuan chino; USD = dólar estadounidense; P2P = entre particulares.

**Qué es esto.** En la cartera Bigtangle puedes intercambiar **BIG** directamente por moneda fiduciaria (WeChat Pay / Alipay / banco, o **PayPal USD**). Los BIG del vendedor se depositan primero en una **dirección de depósito en garantía** que solo puede moverse cuando dos de las tres partes —vendedor, comprador y plataforma— están de acuerdo; el comprador paga el dinero directamente al vendedor; y el vendedor libera los BIG cuando ha confirmado el cobro en su propio extracto. La plataforma no custodia tu dinero ni toca la moneda fiduciaria.

**Sobre las capturas.** Las imágenes siguientes proceden del entorno de demostración en un dispositivo real; los importes y los hashes son datos de demostración y no implican dinero real.

Esta guía muestra: el vendedor publica una oferta de venta de BIG, el comprador compra, se bloquea el depósito, el comprador paga, el vendedor confirma, se liberan los BIG y, por último, el reembolso cuando se agota el tiempo. Tipo de cambio **BIG/CNY = 0.01**, oferta **10,000 BIG → 100 CNY**.

## Resumen del flujo

```
Pendiente de emparejar → Emparejado → Depósito bloqueado → Pago pendiente → Pago reclamado → Pago confirmado → Depósito liberado → Completado
```

Cada paso aparece en la tarjeta de la operación dentro de la aplicación; el estado solo avanza, nunca se salta ni retrocede.

Ruta opcional: si después del pago las partes no se ponen de acuerdo, cualquiera de ellas puede congelar la operación y abrir una disputa, y la plataforma ayuda a resolverla (liberar los BIG al comprador o reembolsar al vendedor).


**PayPal (dólares).** Al elegir **PayPal**, la moneda fiduciaria cambia automáticamente a **USD** y la cuenta de cobro pasa a ser un correo de PayPal; el resto del flujo es idéntico. Demostración completa en [p2p-paypal.zh.md](p2p-paypal.zh.md) → `assets/p2p-paypal.zh.mobile.pdf` (**10,000 BIG → 100 USD**).



---

## 1. El vendedor guarda un perfil de cobro

El vendedor abre **P2P → Mis operaciones**, elige el método de cobro (WeChat, Alipay, banco o PayPal) y rellena el nombre del titular y el número de cuenta (en PayPal, el correo). Estos datos solo se muestran al comprador cuando la operación ya está cerrada y nunca aparecen en el libro público de ofertas.

![El vendedor guarda el perfil de pago de WeChat](assets/screenshots/p2p-cny-wechat-01-profile-es.png)

---

## 2. El vendedor publica una oferta de BIG

En **Publicar oferta de venta**, el vendedor indica el token (`bc`), la cantidad **10,000**, el precio **0.01**, la moneda fiduciaria **CNY** y el método de cobro **WeChat**, y la publica.

Una vez publicada, la oferta aparece en el libro público con el estado **Pendiente de emparejar**. El vendedor puede retirar en cualquier momento una oferta que aún no se haya emparejado.

![Publicar una oferta de venta con wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-es.png)

---

## 3. El comprador empareja la oferta

El comprador abre la oferta, introduce la dirección donde quiere recibir los BIG y confirma la compra. En este momento todavía no hace falta indicar ninguna cuenta de WeChat ni de Alipay: los datos de cobro del vendedor se muestran solo a este comprador, una vez bloqueado el depósito.

La aplicación crea un número de operación único para esta compra y prepara la dirección de depósito; el estado pasa a **Emparejado**.

![El comprador rellena la dirección de recepción](assets/screenshots/p2p-cny-wechat-03-match-es.png)

![Operación creada en Emparejado](assets/screenshots/p2p-cny-wechat-04-matched-es.png)

---

## 4. El vendedor bloquea los BIG en el depósito

La aplicación genera para esta operación una **dirección de depósito 2-de-3**: hacen falta dos de las tres partes —vendedor, comprador y plataforma— para mover los fondos, y ninguna puede llevárselos por sí sola.

El vendedor transfiere **10,000 BIG** a esa dirección y pega en la aplicación el hash de esa transferencia. Cuando la aplicación ha comprobado el importe y la dirección de destino, el estado pasa a **Depósito bloqueado**. El comprador puede ver que los BIG ya están bloqueados antes de pagar la moneda fiduciaria.

![El vendedor pega el hash de la transferencia al depósito](assets/screenshots/p2p-cny-wechat-05-escrow-lock-es.png)

![Depósito bloqueado](assets/screenshots/p2p-cny-wechat-06-escrow-locked-es.png)

---

## 5. El comprador obtiene las instrucciones de pago

El comprador pulsa **Detalles de pago** y ve:

- El nombre del titular
- La cuenta de cobro (WeChat / Alipay / banco, o el correo de PayPal)
- El importe exacto **100 CNY**
- El **código de concepto** exclusivo de esta operación
- La fecha límite de pago

Al hacer la transferencia, el comprador debe escribir el código de concepto en el concepto. El estado pasa a **Pago pendiente**; si no se paga antes de la fecha límite, la operación caduca y se reembolsa.

![Instrucciones de pago: titular, cuenta, 100 CNY, concepto](assets/screenshots/p2p-cny-wechat-08-instructions-es.png)

---

## 6. El comprador paga en CNY y lo declara

El comprador transfiere **100 CNY** desde su propia aplicación de WeChat, escribe el código de concepto en el concepto, pega el número de operación (número de referencia) en **Número de operación** y pulsa **He pagado**.

Puede adjuntar una imagen del comprobante de pago; la imagen solo se guarda en el servidor y no se escribe en la cadena.

![Número de operación introducido](assets/screenshots/p2p-cny-wechat-09-payment-pending-es.png)

El estado pasa a **Pago reclamado**. Los BIG siguen bloqueados: esto es solo la declaración de pago del comprador.

![Pago reclamado](assets/screenshots/p2p-cny-wechat-10-payment-claimed-es.png)

---

## 7. El vendedor confirma en su propio extracto

La tarjeta del vendedor muestra el número de referencia y el concepto que ha indicado el comprador. El vendedor comprueba solo en su propio extracto de WeChat el **importe + concepto + hora + número de referencia**, y únicamente cuando todo cuadra pulsa **Confirmar cobro**.

Una captura de pantalla no sirve como prueba; lo que cuenta es el dinero que ha entrado realmente en su propia cuenta.

![El vendedor ve el número de referencia + el aviso de confirmación](assets/screenshots/p2p-cny-wechat-11-seller-confirm-es.png)

El estado pasa a **Pago confirmado**.

![Pago confirmado](assets/screenshots/p2p-cny-wechat-12-payment-verified-es.png)

---

## 8. El vendedor libera el depósito

> **Vendedor: libera el depósito cuanto antes.** Nada más confirmar el cobro, pulsa **Liberar fondos**. Retrasar la liberación baja la puntuación del vendedor; los retrasos graves o repetidos lo marcan como **poco fiable**, lo que afecta a sus próximas operaciones.

En cuanto el vendedor confirma el cobro, pulsa **Liberar fondos**; la plataforma firma junto con él y los BIG se envían a la dirección de cobro del comprador. Bastan la firma del vendedor y la de la plataforma para completar la liberación, y ninguna de las dos partes puede mover ese dinero por separado.

Como el vendedor ha cobrado directamente, no hay ningún paso adicional de envío de moneda fiduciaria y la operación termina en ese momento.

![Depósito liberado](assets/screenshots/p2p-cny-wechat-13-escrow-released-es.png)

![Completado](assets/screenshots/p2p-cny-wechat-14-completed-es.png)

El estado pasa a **Completado**.

---

## 9. Opcional: la plataforma ayuda a resolver una disputa

Si las partes no están de acuerdo sobre el pago (importe incorrecto, dinero no recibido, el vendedor tarda en liberar, etc.), cualquiera de ellas puede congelar la operación y abrir una disputa. La plataforma revisa el depósito y las pruebas de pago y decide **liberar los BIG al comprador** o **reembolsar al vendedor**.

Las disputas perdidas y los retrasos repetidos quedan registrados en la reputación del vendedor y, en casos graves, pueden marcarlo como **poco fiable**.

---

## 10. Tiempo agotado o fallo → reembolso

Si el comprador no paga nunca, el vendedor puede dejar que la operación caduque; los BIG en depósito vuelven al vendedor sin necesidad del consentimiento del comprador.

Ninguna de las partes retiene nunca el dinero de la otra.

---

## 11. Opcional: «Verificar con mi teléfono» (comprador, liberación retrasada)

No es un paso necesario en una liquidación normal. El comprador solo ve **«Verificar con mi teléfono»** cuando el vendedor retrasa la liberación (más de **30 minutos** desde que el comprador declara el pago, o si el cobro ya está confirmado y aun así no libera) **o** cuando ya hay una disputa abierta.

Solo aparece para **Alipay / banco**, porque el comprador puede leer los movimientos de su cuenta; WeChat solo notifica al receptor y PayPal no tiene puente de lectura, así que en esos dos casos no se muestra. El comprador hace una lectura con su propio teléfono emparejado, y la cartera firma y envía el resultado; la verificación queda registrada en la reputación del vendedor, pero no sustituye la liberación que el vendedor debe hacer cuanto antes.

---

## Comparativa: Binance P2P y esta liquidación

| Función | Binance P2P | Esta liquidación |
|---|---|---|
| Verificación fiat | El vendedor pulsa «Confirmar» (sistema de reputación) | El vendedor confirma en su propio extracto y la plataforma libera según el protocolo |
| Custodia fiat | La plataforma (comprador → vendedor) | El comprador paga directamente al vendedor; la plataforma no toca la moneda fiduciaria |
| Depósito | Libro interno de la plataforma | Depósito 2-de-3 en la cadena, verificable públicamente |
| Reembolso | Ticket con atención al cliente | La operación caduca y vuelve automáticamente al vendedor |
| Resolución de disputas | Atención al cliente humana (varios días) | Disputa en la aplicación + decisión de la plataforma (más rápida) |

---

## Línea de tiempo

```
Emparejado          14:20  Importe fijado al emparejar
Depósito bloqueado  14:23  El vendedor transfiere los BIG y la aplicación confirma la recepción
Pago pendiente      14:24  El comprador ve las instrucciones de pago
Pago reclamado      14:25  El comprador paga e indica el número de referencia
Pago confirmado     14:26  El vendedor confirma en su propio extracto
Depósito liberado   14:27  Vendedor y plataforma firman juntos; los BIG van al comprador
Completado          14:27  Fin de la operación
```

---

Si quieres conocer los detalles de implementación —máquina de estados, firmas, scripts de depósito e interfaces—, consulta la documentación para desarrolladores `docs/p2p.md`.
