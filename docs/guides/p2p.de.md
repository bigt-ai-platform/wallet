# P2P-Abwicklung — wallet-nativer Tausch über zwei Zahlungswege

**Worum es geht.** Ein Peer-to-Peer-Tausch zwischen Krypto auf **Bigtangle L0**
und Fiat über **PayPal** (oder die CNY-Wege — WeChat Pay / Alipay / Bank). Der
Verkäufer hinterlegt Token in einer **2-von-3-P2SH-Adresse** (Verkäufer, Käufer,
Engine); der Käufer zahlt eine Betragsgenaue Fiat-Forderung; die Engine weist die
Zahlung nach und der Escrow wird freigegeben. Jeder unwiderrufliche Schritt wird
mit dem eigenen PQ-Schlüssel der Wallet signiert, und die Engine kann einen
Transfer immer nur **mit-signieren** — sie hält niemals dein Geld.

**Wo.** Der Bildschirm **P2P** in der Wallet (Seitenleiste → Trade → P2P). Alles
unten stammt aus diesem Bildschirm im lokalen Demo-Build.

**Demo vs. Live.** Die Screenshots stammen aus dem Demo-Build: Die Engine läuft
im Mock-PayPal-Modus (gestubbte Rechnungs-URLs und synthetische Transaktions-
Hashes), und die Schritte Lock/Verify/Release werden mit einem lokalen
Engine-Schlüssel signiert. Der Zustandsautomat, die Signaturen, das
Append-only-Ereignisprotokoll und der On-Chain-Audit-Anker sind echt; nur die
externen PayPal-Aufrufe und der L0-Broadcast sind gestubbt.

**Kein manuelles „Bestätigen“.** Auf dem PayPal-Weg gibt es keinen
Verkäufer-„Bestätigen“-Knopf — die Engine prüft die Zahlung anhand ihrer eigenen
Nachweise. (Die CNY-Wege ohne Webhook nutzen stattdessen eine ausdrückliche
Bestätigung durch den Verkäufer; siehe `docs/p2pcny.md`.)

---

## Der Ablauf auf einen Blick

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Schritt | Wer handelt | On-Chain / Engine |
|---|---|---|---|
| 1 | Verkäufer stellt eine signierte Verkaufsorder ein | Verkäufer | Order gespeichert, nicht finanziert |
| 2 | Käufer matcht (Empfangsadresse + PayPal-Konto) | Käufer | `swapId` erzeugt, Escrow-Adresse abgeleitet |
| 3 | Verkäufer finanziert den 2-von-3-Escrow, Engine weist den Lock nach | Verkäufer + Engine | `ESCROW_LOCKED` auf L0 |
| 4 | Käufer zahlt die betragsgenaue Rechnung und meldet sie | Käufer | `PAYMENT_PENDING` |
| 5 | Engine verifiziert die Zahlung selbst | Engine | `PAYMENT_VERIFIED` |
| 6 | Engine + Käufer signieren die Freigabe, Token bewegen sich | Engine + Käufer | `ESCROW_RELEASED` |
| 7 | Engine zahlt den Verkäufer über PayPal Payouts aus | Engine | `COMPLETED` |

Jeder Übergang wird als `social.p2p-swap`-Record auf der L1-SOCIAL-Kette
verankert, sodass der gesamte Lebenszyklus öffentlich auditierbar ist, ohne die
PayPal-Daten einer Seite offenzulegen.

---

## 1. Der Verkäufer stellt eine Verkaufsorder ein

Im Tab **Open sells** füllst du die Order aus: das Token und die Menge, die du
gibst, den gewünschten Fiat-Preis, die Währung, die Chain des Tokens und die
**Zahlungsmethode** (PayPal oder ein CNY-Weg). Die Konditionen werden beim
Einstellen in die Order geschrieben, daher wird dies mit deinem Wallet-Schlüssel
signiert.

![Das Verkaufsorder-Formular, PayPal-Weg gewählt](/demo/p2p/p2p-01-order-de.png)

Nach dem Einstellen ist die Order `ACTIVE` in der Engine und erscheint im
öffentlichen Orderbuch (ohne persönliche Daten):

![Die Order ist live im Buch](/demo/p2p/p2p-02-active-de.png)

---

## 2. Der Käufer matcht

Der Käufer öffnet die Order und gibt die **Empfangsadresse** für die
freigegebenen Token sowie das **PayPal-Konto** an, das die Rechnung erhalten soll
(plus eine E-Mail für die Rechnung). Das Matchen verpflichtet den Käufer zu
zahlen, daher wird auch dies signiert:

![Der Käufer trägt Empfangsadresse und PayPal-Konto ein](/demo/p2p/p2p-03-match-de.png)

Die Engine erzeugt eine eindeutige `swapId` für den Lebenszyklus, und der Tausch
geht in `MATCHED` über, sichtbar im Tab **My swaps** des Käufers:

![Der Tausch ist MATCHED](/demo/p2p/p2p-04-matched-de.png)

---

## 3. Escrow-Lock — der Verkäufer finanziert L0

Der Verkäufer sendet die Token an die deterministische 2-von-3-Escrow-Adresse
und meldet den `txHash` der Transaktion. Die Engine weist den Lock aus der Chain
nach (`CONFIRMED`, Ziel `escrowAddress`, Betrag) und schlägt fehl, wenn eine
Prüfung nicht hält. Der Tausch ist nun `ESCROW_LOCKED`:

![Der Verkäufer sperrt den Escrow](/demo/p2p/p2p-05-escrow-locked-de.png)

Der Käufer sieht die Mittel **vor** dem Senden von Fiat gesichert und erhält,
sobald der Lock nachgewiesen ist, eine Aktion **I have paid** (Ich habe bezahlt):

![Der Käufer sieht den gesperrten Escrow](/demo/p2p/p2p-06-buyer-locked-de.png)

---

## 4. Der Käufer zahlt

Der Käufer zahlt die gehostete PayPal-Rechnung (PayPal hält das Geld — die
Engine nie) und meldet die Zahlung. Dies ist nur ein *Hinweis*; die eigentliche
Prüfung ist der Nachweis der Engine. Der Tausch ist `PAYMENT_PENDING`, und ein
Timeout-Timer startet — wird die Rechnung nie bezahlt, kann der Verkäufer
ablaufen lassen und den Escrow ohne Zustimmung des Käufers erstatten:

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-de.png)

---

## 5. Die Engine verifiziert die Zahlung

Es ist keine Verkäuferbestätigung beteiligt. Die Engine prüft die Zahlung aus
ihrer eigenen Quelle und setzt den Tausch auf `PAYMENT_VERIFIED` — der Escrow
kann nun an die Empfangsadresse des Käufers freigegeben werden:

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-de.png)

---

## 6. Release — die Mittel bewegen sich

Release bewegt die hinterlegten Token: Engine und Käufer signieren jeweils eine
Ausgabe des Escrow-Outputs, und zwei Signaturen erfüllen das 2-von-3-Skript. Die
Token landen auf der Empfangsadresse des Käufers, der Tausch ist
`ESCROW_RELEASED`:

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-de.png)

---

## 7. Auszahlung — der Verkäufer erhält das Fiat

Der letzte Schritt zahlt den Verkäufer über PayPal Payouts aus, und der Tausch
erreicht `COMPLETED`:

![COMPLETED](/demo/p2p/p2p-10-completed-de.png)

Das Auszahlungsergebnis (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) kommt per
PayPal-Webhook oder wird als Fallback gepollt; ein Fehler kann aus `COMPLETED`
wiederholt werden, ohne den Handel neu zu machen.

---

## Was dich schützt

| Risiko | Gegenmaßnahme |
|---|---|
| Gegenseite springt ab | Mittel liegen in einer 2-von-3-P2SH-Adresse; niemand kann sie allein bewegen |
| Unter- oder Überzahlung | Die Rechnung ist betragsgenau, sie wird also voll oder gar nicht bezahlt |
| Falsche Zahlungsbehauptung | Die Engine verifiziert die Zahlung selbst — der Zahler kann sie nicht selbst behaupten |
| Engine wird bösartig | Nur-Engine-Schritte benötigen die Engine-DID-Signatur; jeder Übergang wird verankert und ist öffentlich auditierbar |
| Rückbuchung nach Release | `PAYMENT.CAPTURE.REVERSED` setzt eine Sperre: Vorwärtsschritte stoppen, Refund/Expire bleiben erreichbar |
| Streitfall | `CUSTOMER.DISPUTE.*` pausiert den Tausch bis zur Klärung |
| Auszahlungsfehler | `HELD`/`FAILED`/`BLOCKED` sind erstklassige Zustände; mit derselben Auszahlungsreferenz wiederholen |

---

## Live gehen

Die Demo läuft gegen den In-Repo-Settlementservice mit Mock-PayPal. Für den
echten Ablauf brauchst du ein PayPal-Business-Konto mit aktivierten Payouts,
dessen API-Zugangsdaten und Webhook-ID sowie den an den L0-Broadcast
angeschlossenen Escrow-Signer. Bis dahin läuft die Engine mit demselben
Zustandsautomaten, ohne echtes Geld zu bewegen.
