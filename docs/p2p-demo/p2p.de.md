# P2P-Abwicklung — CNY-Swap mit vom Verkäufer bestätigter Freigabe

**Status: Demo-Build + Engine im Repo.** Alles nachfolgende ist der Abwicklungsfluss wie gebaut: 2-von-3-P2SH-Eskrow auf Bigtangle L0 und eine vom Verkäufer bestätigte CNY-Strecke (WeChat Pay / Alipay / Bank). Eine persönliche Überweisung hat kein maschinell verifizierbares Zahlungsereignis, daher ist der eigene Kontoauszug des Verkäufers das Fiat-Signal. Screenshots stammen aus dem Demo-Build (Memory Store, keine Chain-Prüfung — die Lock/Release-Hashes sind synthetisch). Das Design liegt in `docs/p2p.md`.

Diese Anleitung führt durch das Einlisten von USDT zum Verkauf, das Matching mit einem Käufer, die Eskrow-Sperre, die Zahlung von CNY durch den Käufer **direkt** an den Verkäufer, die Bestätigung des Verkäufers auf dem eigenen Kontoauszug, die Eskrow-Freigabe und die Rückerstattung bei Timeout.

Für den kombinierten Drei-Schienen-Durchlauf (WeChat / Alipay / Bank) siehe [p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf`.

---

## 1. Verkäufer speichert ein Zahlungsprofil

Der Verkäufer öffnet **P2P → Meine Swaps**, wählt die Schiene (`wechat`) und gibt den 收款-Namen und das Konto ein. Das Profil wird serverseitig unter der DID des Verkäufers gespeichert und ist **nicht** Teil des öffentlichen Orderbuchs — es wird nur dem gematchten Käufer offengelegt.

![Verkäufer speichert das WeChat-Zahlungsprofil](assets/screenshots/p2p-cny-wechat-01-profile-de.png)

---

## 2. Verkäufer listet USDT

Übermittelt eine DID-signierte Limit-Order an die Settlement Engine:

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

Die Order wird gegen die DID-Signatur des Verkäufers validiert. Status: `ACTIVE`; sie läuft nach `validUntil` ab.

![Eine Verkaufsorder mit wechat / CNY einstellen](assets/screenshots/p2p-cny-wechat-02-order-de.png)

---

## 3. Käufer matcht die Order

Der Käufer übermittelt ein DID-signiertes Match und gibt die Adresse an, die die Eskrow-Freigabe erhalten soll. Es gibt kein Konto/E-Mail zu erfassen — zum Matchzeitpunkt ist nichts über die Fiat-Schiene nötig:

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

Status: `MATCHED`. Für den Lebenszyklus wird eine eindeutige `swapId` erzeugt und die 2-von-3-Eskrow-Adresse aus den Schlüsseln von Verkäufer + Käufer + Engine abgeleitet.

![Der Käufer trägt die Empfangsadresse ein](assets/screenshots/p2p-cny-wechat-03-match-de.png)

![Swap bei MATCHED erstellt](assets/screenshots/p2p-cny-wechat-04-matched-de.png)

---

## 4. Verkäufer sperrt USDT im 2-von-3-Eskrow

Die Eskrow-Adresse ist ein P2SH-Skript mit drei Schlüsseln — Verkäufer, Käufer, Engine — und einer Schwelle von zwei:

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

Die Engine belegt die Sperre mit `getTransactionStatus` — `CONFIRMED`, Ziel `escrowAddress`, Betrag 10 — und schlägt fehlgeschlossen fehl, wenn eine Prüfung nicht besteht. Status: `ESCROW_LOCKED`. Der Käufer sieht die Mittel gesichert, bevor er zahlt.

![Der Verkäufer fügt den Eskrow-Tx-Hash ein](assets/screenshots/p2p-cny-wechat-05-escrow-lock-de.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-de.png)

---

## 5. Käufer ruft die Zahlungsanweisungen ab

Der Käufer drückt **Zahlungsdetails**. Die Engine legt das Profil des Verkäufers offen, plus einen **Swap-spezifischen Verwendungszweck**, den die Überweisung *tragen muss*, den exakten Betrag und eine Frist:

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

Status: `PAYMENT_PENDING`. Ein Timeout startet — ein unbezahlter Swap kann ohne Zustimmung des Käufers verfallen und erstattet werden.

![Zahlungsanweisungen: 户名, Konto, 715 CNY, Verwendungszweck](assets/screenshots/p2p-cny-wechat-08-instructions-de.png)

---

## 6. Käufer zahlt CNY und reklamiert mit der 流水号

Der Käufer überweist `715 CNY` in seiner eigenen WeChat-App, fügt die Transaktionsnummer (流水号) in **Transaction ID** ein und drückt **Ich habe bezahlt**. Das optionale Belegbild wird serverseitig gespeichert; nur sein `sha256` wird am Swap-Ereignis verankert.

![Transaction ID (流水号) eingegeben](assets/screenshots/p2p-cny-wechat-09-payment-pending-de.png)

Status: `PAYMENT_CLAIMED` — die Token sind noch gesperrt. Dieser Zustand ist die Behauptung des Käufers und nichts weiter.

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-de.png)

---

## 7. Verkäufer bestätigt auf dem eigenen Kontoauszug

Die Karte des Verkäufers zeigt die 流水号 des Käufers und den Verwendungszweck. Der Verkäufer prüft **Betrag + Verwendungszweck + Zeit + 流水号 im eigenen Konto** (Screenshots zählen nie) und drückt erst dann **Empfang bestätigen**:

![Verkäufer sieht 流水号 + die Bestätigungswarnung](assets/screenshots/p2p-cny-wechat-11-seller-confirm-de.png)

Status: `PAYMENT_VERIFIED`.

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-de.png)

---

## 8. Engine und Verkäufer geben das Eskrow frei

Zwei Signaturen erfüllen das Skript: die des Verkäufers (bei der Sperre vorab signiert, oder eine Co-Signatur) und die der Engine. Keine einzelne Partei kann die Mittel bewegen.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Der Freigabe-Spend wird zusammengesetzt und an `receiveAddress` broadcastet. Status: `ESCROW_RELEASED`. Der Käufer hält die Token; da der Verkäufer bereits in CNY bezahlt wurde, gibt es keinen Fiat-Auszahlungsschritt — `complete` schließt den Swap ab.

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-de.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-de.png)

---

## 9. Timeout oder Fehler → Rückerstattung

Wenn der Käufer nie zahlt, co-signieren Engine und Verkäufer dasselbe Skript zurück an den Verkäufer:

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Die Rückerstattung braucht weder Zustimmung des Käufers noch einen Timelock — die Schwelle wird mit den anderen zwei Schlüsseln erreicht. Status: `EXPIRED` → `ESCROW_REFUNDED`. Keine Partei hält jemals die Mittel der anderen.

---

## 10. Geräte-Verifizierung — das eigene Telefon des Verkäufers

Der eigene Kontoauszug des Verkäufers ist der Beleg; die Engine kann ihn über die
App auf dem Telefon ([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp))
automatisch lesen. WeChat verbirgt seine Oberfläche vor der Barrierefreiheit,
daher liest die App für WeChat die „收款到账“-Benachrichtigung (bei Alipay/Bank
den Bildschirm).

Die Kopplung ist ein **kurzer, einmalig verwendbarer Code**, den die App auf dem
Server-Bildschirm zeigt: Endpunkt + Code im **Geräte**-Bildschirm der Wallet
(**Mit Code koppeln**) bzw. auf der **Mobile**-Seite von dai eingeben — die App
gibt ein Token pro Gerät zurück (`POST /pair/claim`); Widerruf unter Einstellungen
› Zugriff › Gekoppelte Geräte.

Mit `SETTLEMENT_CNY_AUTO_RELEASE_ON=seller_receipt` kann die Engine danach ohne
manuelles Bestätigen automatisch bestätigen.

## Vergleich: Binance P2P vs. diese Abwicklung

| Funktion | Binance P2P | Diese Abwicklung |
|---|---|---|
| Fiat-Prüfung | Verkäufer klickt „Bestätigen" (Ehrensystem) | Verkäufer bestätigt auf dem eigenen Kontoauszug; die Engine erzwingt das Protokoll |
| Fiat-Custody | P2P (Käufer → Verkäufer) | P2P (Käufer → Verkäufer) — die Engine berührt Fiat nie |
| Eskrow | Internes Ledger | 2-von-3-P2SH auf Bigtangle L0 (prüfbar) |
| Rückerstattung | Support-Ticket | Engine + Verkäufer co-signieren, keine Zustimmung des Käufers |
| Streitlösung | Menschlicher Support (Tage) | Chain-Tx-Beleg + Proof Store + Swap-Verwendungszweck (Minuten) |

---

## Vollständige Timeline

```
MATCHED          14:20:00  Betrag beim Match festgelegt
ESCROW_LOCKED    14:23:15  L0-Tx CONFIRMED an der 2-von-3-Adresse
PAYMENT_PENDING  14:24:00  Anweisungen ausgegeben (Konto + Verwendungszweck f71ade2d23e9)
PAYMENT_CLAIMED  14:25:10  Käufer fügte 流水号 4200001234567890 ein
PAYMENT_VERIFIED 14:26:40  Verkäufer bestätigte auf dem eigenen WeChat-Kontoauszug
ESCROW_RELEASED  14:27:20  Verkäufer + Engine co-signierten den Spend an receiveAddress
COMPLETED        14:27:21  keine Fiat-Auszahlung — der Verkäufer hält die CNY bereits
```

---

## Vollständiger Demo-Ablauf

```typescript
// 1. Verkäufer speichert ein CNY-Zahlungsprofil            (POST /profiles)
// 2. Verkäufer übermittelt eine signierte Limit-Order     (POST /orders)
// 3. Käufer matcht mit einem signierten Match             (POST /orders/:id/match)
// 4. Verkäufer finanziert 2-von-3-P2SH-Eskrow auf L0; Engine belegt es (escrow_lock)
// 5. Käufer ruft die Zahlungsanweisungen ab               (POST /swaps/:id/payment-instructions)
// 6. Käufer zahlt in WeChat und reklamiert die 流水号      (POST /swaps/:id/proof)
// 7. Verkäufer bestätigt auf dem eigenen Kontoauszug      (POST /swaps/:id/confirm)
// 8. Verkäufer + Engine co-signieren die Freigabe         (POST /swaps/:id/transitions, action: release)
// 9. Engine schließt den Swap ab                          (…/transitions, action: complete)
```

Entscheidender Unterschied zu Binance P2P: Die Mittel liegen in einem 2-von-3-Skript, das keine Partei allein kontrolliert, jeder Übergang wird auf L1-SOCIAL verankert, und der eigene Kontoauszug des Verkäufers — nicht ein Support-Ticket — ist die Fiat-Wahrheit.
