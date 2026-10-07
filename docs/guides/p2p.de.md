# P2P-Abwicklung — Cross-Rail-Swap mit KI-Prüfung

**Status: Zielentwurf, nicht umgesetzt.** Alles nachfolgende beschreibt den Abwicklungs­fluss, den wir bauen: 2-von-3-P2SH-Eskrow auf Bigtangle L0 und echte PayPal-API-Prüfung. Der heute laufende Demo-Build ist eine State Machine auf Postgres mit simulierter Fiat-Strecke. Screenshots stammen aus diesem Demo-Build; das Design liegt im dai-Repository, `docs/p2p.md`.

Diese Anleitung demonstriert den KI-nativen P2P-Abwicklungsfluss: USDT zum Verkauf einstellen, mit einem Käufer matchen, Eskrow-Sperre, Fiat-Zahlung mit automatischer Prüfung, Eskrow-Freigabe und Rückerstattung bei Timeout. Kein manueller „Bestätigen"-Button — die Settlement Engine prüft die Zahlung anhand eines PayPal-Webhooks.

---

## 1. Dashboard-Übersicht

Das P2P-Dashboard zeigt alle aktiven Swaps mit Status, Kurs und Transaktionsreferenzen.

![Dashboard](demo-output/screenshots/p2p-dashboard-de.png)

Das Dashboard zeigt alle aktiven Swaps mit Status, Kurs und Transaktionsreferenzen. Jede Karte zeigt die Swap-ID, das Asset-Paar (z. B. 100 USDT ⇄ 101 USD), ein farbcodiertes Status-Badge und eine ausklappbare Timeline.

---

## 2. Verkäufer stellt USDT ein

Übergibt eine DID-signierte Limit-Order an die Settlement Engine.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

Der Verkäufer übergibt eine signierte Limit-Order: 100 USDT für 101 USD über PayPal verkaufen. Die Settlement Engine validiert die DID-Signatur. Status: ACTIVE. Die Order läuft nach validUntil ab.

---

## 3. Käufer matcht die Order

Der Käufer übergibt eine signierte Market-Order. Der Kurs wird zum Matchzeitpunkt über einen Oracle gesichert, der Rechnungsbetrag ist ab diesem Moment fest.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

Der Käufer matcht die Order mit einer DID-signierten Market-Order und liefert die Adresse für die Eskrow-Freigabe sowie das zu zahlende PayPal-Konto. Status: MATCHED. Für den Lebenszyklus entsteht eine eindeutige swapId.

---

## 4. Verkäufer sperrt USDT im 2-von-3-Eskrow

Die Eskrow-Adresse ist ein P2SH-Skript mit drei Schlüsseln — Verkäufer, Käufer, Engine — und einer Schwelle von zwei.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

Der Verkäufer finanziert die Eskrow-Adresse auf Bigtangle L0. Die Engine belegt die Sperre mit `getTransactionStatus` — `CONFIRMED`, Ziel `escrowAddress`, Betrag 100 — und schlägt fehlgeschlossen, wenn einer der drei Prüfpunkte nicht gilt. Status: ESCROW_LOCKED. Der Käufer sieht die gesicherten Mittel, bevor er Fiat sendet.

---

## 5. Engine stellt Rechnung, Käufer zahlt via PayPal

Die Engine erstellt eine PayPal-Rechnung mit exaktem Betrag und übergibt die gehostete URL an den Käufer.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → gehostete Checkout-URL; Rechnungsnummer = swapId
```

Der Käufer zahlt die gehostete Rechnung. Die Engine berührt das Geld nicht — PayPal hält es. Keine Bestätigung durch den Verkäufer nötig. Status: PAYMENT_PENDING. Der Timeout-Timer startet.

---

## 6. Engine prüft Zahlung automatisch

**Kerninnovation**: kein menschlicher „Bestätigen"-Button. Die Zahlung wird von PayPal belegt, nicht von einer Partei behauptet.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

Die Engine prüft den Webhook `INVOICING.INVOICE.PAID`, dedupliziert über `event.id`. Das ersetzt Binance P2Ps manuellen „Bestätigen"-Button. Kein Verkäufer kann den Nicht-Eingang der Zahlung bestreiten. Status: PAYMENT_VERIFIED.

---

## 7. Engine und Käufer geben das Eskrow frei

Zwei Signaturen erfüllen das Skript: die des Käufers und die der Engine. Keine einzelne Partei kann die Mittel bewegen.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Der Freigabe-Spend wird zusammengesetzt und an `receiveAddress` broadcastet. Status: ESCROW_RELEASED. Der Käufer hält jetzt die Token; der Restaufgabe der Engine ist die Fiat-Auszahlung.

---

## 8. Engine zahlt Verkäufer aus

Die Engine sendet USD über Payouts v1 an das PayPal-Konto des Verkäufers, idempotent pro Swap.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

Die Engine sendet USD an das PayPal-Konto des Verkäufers. Swap COMPLETED. Gesamtdauer: ~3-5 Minuten. Alles DID-signiert, jeder Schritt on-chain oder bei PayPal prüfbar.

---

## 9. Timeout oder Fehler → Rückerstattung

Wird die Rechnung nie bezahlt, unterzeichnen Engine und Verkäufer dasselbe Skript zurück an den Verkäufer.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Die Rückerstattung braucht weder Zustimmung des Käufers noch einen Timelock — die Schwelle wird mit den anderen zwei Schlüsseln erreicht. Status: EXPIRED → ESCROW_REFUNDED. Keine Partei hält jemals die Mittel der anderen.

---

## 10. Verlaufsansicht

Abgeschlossene, abgelaufene und stornierte Swaps sind in der Verlaufsseite sichtbar.

![Verlauf](demo-output/screenshots/p2p-history-de.png)

Die Verlaufsseite listet abgeschlossene, abgelaufene und stornierte Swaps. Jeder Eintrag zeigt das Asset-Paar, den Endstatus, die Timeline-Schritte und die DIDs der Parteien.

---

## Vergleich: Binance P2P vs. AI-Abwicklung

| Funktion | Binance P2P | AI-Abwicklung |
|---------|-------------|---------------|
| Fiat-Prüfung | Verkäufer klickt „Bestätigen" (Ehrensystem) | PayPal-Webhook, RSA-verifiziert (deterministisch) |
| Fiat-Custody | P2P (Käufer → Verkäufer) | PayPal hält bis zur Auszahlung (Käufer → PayPal → Verkäufer) |
| Eskrow | Internes Ledger | 2-von-3-P2SH auf Bigtangle L0 (prüfbar) |
| Rückerstattung | Support-Ticket | Engine + Verkäufer unterzeichnen, ohne Zustimmung des Käufers |
| Streitlösung | Menschlicher Support (Tage) | On-chain-Tx-Beleg + PayPal-Ereignis (Minuten) |

---

## Vollständige Timeline

```
MATCHED          14:20:00  Kurs gesichert, Rechnungsbetrag fest
ESCROW_LOCKED    14:23:15  L0-Tx CONFIRMED auf der 2-von-3-Adresse
PAYMENT_PENDING  14:24:00  Rechnung INV-7f3c91 erstellt
PAYMENT_VERIFIED 14:24:10  Webhook INVOICING.INVOICE.PAID, RSA-verifiziert
ESCROW_RELEASED  14:24:30  Ko-signierter Spend an receiveAddress
COMPLETED        14:25:00  Auszahlungslauf PAYOUT-abc SUCCESS
```

---

## Vollständiger Demo-Ablauf

```typescript
// 1. Verkäufer sendet signierte Limit-Order (POST /api/p2p/orders)
// 2. Käufer matcht mit signierter Market-Order (POST /api/p2p/orders/:id/match)
// 3. Verkäufer finanziert 2-von-3-P2SH-Eskrow auf L0; Engine prüft (getTransactionStatus)
// 4. Engine stellt PayPal-Rechnung; Käufer zahlt (POST /api/p2p/payments/invoice)
// 5. Engine prüft Webhook INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. Engine + Käufer ko-signieren den Freigabe-Spend (POST .../transitions, action: release)
// 7. Engine zahlt Verkäufer aus (POST /api/p2p/payments/payout)
// 8. Beide Parteien sehen COMPLETED-Status auf dem Dashboard
```

Entscheidender Unterschied zu Binance P2P: **kein „Bestätigen"-Button des Verkäufers.** Die Zahlung wird durch einen PayPal-Webhook belegt, und die Mittel liegen in einem 2-von-3-Skript, das keine Partei allein kontrolliert — deterministisch, prüfbar, sofort.
