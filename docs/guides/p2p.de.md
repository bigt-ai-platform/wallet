# P2P-Abwicklung — wallet-nativer CNY-Tausch

**Worum es geht.** Ein Peer-to-Peer-Tausch zwischen Krypto auf **Bigtangle L0**
und CNY-Fiat (WeChat Pay / Alipay / Bank). Der Verkäufer hinterlegt Token in
einer **2-von-3-P2SH-Adresse** (Verkäufer, Käufer, Engine); der Käufer zahlt den
Verkäufer **direkt** in seiner eigenen Zahlungs-App; der Verkäufer bestätigt den
Eingang auf seinem eigenen Kontoauszug, und der Escrow wird freigegeben. Jeder
unwiderrufliche Schritt wird mit dem eigenen PQ-Schlüssel der Wallet signiert,
und die Engine kann eine Ausgabe immer nur **mit-signieren** — sie hält niemals
dein Geld und berührt niemals Fiat.

**Wo.** Der Bildschirm **P2P** in der Wallet (Seitenleiste → Trade → P2P). Alles
unten stammt von diesem Bildschirm im lokalen Demo-Build.

**Demo vs. Live.** Die Screenshots stammen aus dem Demo-Build: Die Engine läuft
mit einem Speicher-Store und ohne Chain-Prüfung, daher nutzen die
Lock/Release-Schritte synthetische Transaktions-Hashes. Der Zustandsautomat, die
Signaturen, das Append-only-Ereignisprotokoll und der On-Chain-Audit-Anker sind
echt; nur der L0-Broadcast ist gestubbt.

**Die Verkäuferbestätigung ist das Fiat-Signal.** Für ein persönliches
WeChat-/Alipay-/Bankkonto gibt es keine Collection-API, also gibt es kein
maschinell verifizierbares Zahlungsereignis, auf das man warten könnte. Der
Verkäufer prüft **Betrag + Verwendungszweck + Zeit + 流水号 in seiner eigenen
App** — ein Screenshot zählt nie — und bestätigt. Designdetails stehen in
`docs/p2p.md`.

---

## Der Ablauf auf einen Blick

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──instructions──▶ PAYMENT_PENDING
                                                                          │
   PAYMENT_PENDING ──proof──▶ PAYMENT_CLAIMED ──confirm──▶ PAYMENT_VERIFIED
                                                                  │
                            PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──complete──▶ COMPLETED
```

| # | Schritt | Wer handelt | On-Chain / Engine |
|---|---|---|---|
| 1 | Verkäufer speichert ein CNY-Sammelprofil | Verkäufer | Profil serverseitig gespeichert, nie im Buch |
| 2 | Verkäufer stellt eine signierte Verkaufsorder ein | Verkäufer | Order gespeichert, nicht finanziert |
| 3 | Käufer matcht (Empfangsadresse) | Käufer | `swapId` erzeugt, Escrow-Adresse abgeleitet |
| 4 | Verkäufer finanziert den 2-von-3-Escrow, Engine weist den Lock nach | Verkäufer + Engine | `ESCROW_LOCKED` auf L0 |
| 5 | Käufer ruft die Zahlungsanweisungen ab | Käufer | `PAYMENT_PENDING` (+ Verwendungszweck pro Tausch) |
| 6 | Käufer zahlt in seiner eigenen App und meldet mit der 流水号 | Käufer | `PAYMENT_CLAIMED` |
| 7 | Verkäufer prüft seinen eigenen Kontoauszug und bestätigt | Verkäufer | `PAYMENT_VERIFIED` |
| 8 | Engine gibt die Token frei, der Tausch ist abgeschlossen | Engine | `ESCROW_RELEASED` → `COMPLETED` |

Jeder Übergang wird als `social.p2p-swap`-Record auf der L1-SOCIAL-Kette
verankert, sodass der gesamte Lebenszyklus öffentlich auditierbar ist, ohne die
Kontodaten einer der beiden Seiten offenzulegen.

---

## 1. Der Verkäufer speichert ein Sammelprofil

Im Tab **My swaps** wählt der Verkäufer einen Weg (WeChat, Alipay oder Bank) und
gibt den 收款-Namen und das Konto ein. Das Profil wird serverseitig unter der DID
des Verkäufers gespeichert und ist **nicht** Teil des öffentlichen Orderbuchs —
es wird nur dem gematchten Käufer durch den Instructions-Aufruf offengelegt.

![Verkäufer speichert das WeChat-Zahlungsprofil](/demo/p2p/p2p-cny-wechat-01-profile-de.png)

---

## 2. Der Verkäufer stellt eine Verkaufsorder ein

Im Tab **Open sells** füllst du die Order aus: das Token und die Menge, die du
gibst, den gewünschten CNY-Preis, die Chain, auf der die Token liegen, und die
**Zahlungsmethode** (wechat / alipay / bank). Die Wahl eines CNY-Wegs schaltet
die Währung auf CNY um. Die Konditionen werden beim Einstellen in die Order
geschrieben, daher wird dies mit deinem Wallet-Schlüssel signiert:

![Das Verkaufsorder-Formular mit dem wechat-Weg](/demo/p2p/p2p-cny-wechat-02-order-de.png)

Nach dem Einstellen ist die Order `ACTIVE` in der Engine und erscheint im
öffentlichen Orderbuch (sie trägt keine persönlichen Daten).

---

## 3. Der Käufer matcht

Der Käufer öffnet die Order und gibt die **Empfangsadresse** für die
freigegebenen Token an. Das Matchen verpflichtet den Käufer zu zahlen, daher wird
auch dies signiert:

![Der Käufer trägt die Empfangsadresse ein](/demo/p2p/p2p-cny-wechat-03-match-de.png)

Die Engine erzeugt eine eindeutige `swapId` für den Lebenszyklus, und der Tausch
geht in `MATCHED` über, sichtbar im Tab **My swaps** des Käufers:

![Der Tausch ist MATCHED](/demo/p2p/p2p-cny-wechat-04-matched-de.png)

---

## 4. Escrow-Lock — der Verkäufer finanziert L0

Der Verkäufer sendet die Token an die deterministische 2-von-3-Escrow-Adresse
und meldet den `txHash` der Transaktion. Die Engine weist den Lock aus der Chain
nach (`CONFIRMED`, Ziel `escrowAddress`, Betrag) und schlägt fehl, wenn eine
Prüfung nicht hält:

![Der Verkäufer fügt den Escrow-Tx-Hash ein](/demo/p2p/p2p-cny-wechat-05-escrow-lock-de.png)

Der Tausch ist nun `ESCROW_LOCKED`. Der Käufer sieht die Mittel gesichert
**vor** dem Senden von Fiat und erhält eine Aktion **Payment details**
(Zahlungsdetails):

![ESCROW_LOCKED](/demo/p2p/p2p-cny-wechat-06-escrow-locked-de.png)

---

## 5. Der Käufer ruft die Zahlungsanweisungen ab

Der Käufer drückt **Payment details** (Zahlungsdetails); die Engine legt das
Profil des Verkäufers offen und prägt einen **Verwendungszweck-Code pro Tausch**,
den die Überweisung *tragen muss*, plus den genauen Betrag und eine Frist. Die
Anweisungen werden inline in der Tauschkarte angezeigt:

![Zahlungsanweisungen: 户名, Konto, 715 CNY, Verwendungszweck](/demo/p2p/p2p-cny-wechat-08-instructions-de.png)

Der Tausch ist `PAYMENT_PENDING`, und ein Timeout startet — zahlt der Käufer
nie, kann der Verkäufer den Escrow ohne Zustimmung des Käufers ablaufen lassen
und erstatten.

---

## 6. Der Käufer zahlt und meldet mit der 流水号

Der Käufer überweist den genauen Betrag in seiner eigenen
WeChat-/Alipay-/Bank-App, fügt die Transaktionsnummer (流水号) in
**Transaction ID** ein und drückt **I have paid** (Ich habe bezahlt). Ein
optionales Belegbild wird serverseitig gespeichert; nur sein `sha256` wird im
Swap-Ereignis verankert:

![Transaction ID (流水号) eingegeben](/demo/p2p/p2p-cny-wechat-09-payment-pending-de.png)

Der Status ist nun `PAYMENT_CLAIMED` — **die Token sind weiterhin gesperrt.**
Dieser Zustand existiert allein als Behauptung des Käufers:

![PAYMENT_CLAIMED](/demo/p2p/p2p-cny-wechat-10-payment-claimed-de.png)

---

## 7. Der Verkäufer bestätigt auf seinem eigenen Kontoauszug

Die Karte des Verkäufers zeigt die 流水号 des Käufers und den Verwendungszweck.
Der Verkäufer prüft **Betrag + Verwendungszweck + Zeit + 流水号 in seinem
eigenen Konto** und drückt erst dann **Confirm received** (Eingang bestätigen):

![Der Verkäufer sieht die 流水号 und die Bestätigungswarnung](/demo/p2p/p2p-cny-wechat-11-seller-confirm-de.png)

Der Tausch ist `PAYMENT_VERIFIED`:

![PAYMENT_VERIFIED](/demo/p2p/p2p-cny-wechat-12-payment-verified-de.png)

---

## 8. Release — die Mittel bewegen sich

Release bewegt die hinterlegten Token: Der Verkäufer (Presign oder Co-Sign) und
die Engine signieren jeweils eine Ausgabe des Escrow-Outputs, und zwei
Signaturen erfüllen das 2-von-3-Skript. Die Token landen auf der Empfangsadresse
des Käufers:

![ESCROW_RELEASED](/demo/p2p/p2p-cny-wechat-13-escrow-released-de.png)

Da der Verkäufer direkt bezahlt wurde, gibt es keinen Fiat-Auszahlungsschritt —
der Tausch ist abgeschlossen:

![COMPLETED](/demo/p2p/p2p-cny-wechat-14-completed-de.png)

---

## Was dich schützt

| Risiko | Gegenmaßnahme |
|---|---|
| Gegenseite springt ab | Mittel liegen in einer 2-von-3-P2SH-Adresse; niemand kann sie allein bewegen |
| Unter- oder Überzahlung | Der Betrag wird beim Match festgelegt; die Anweisungen tragen die genaue Summe und einen Verwendungszweck pro Tausch |
| Falsche Zahlungsbehauptung | Die Behauptung des Käufers allein gibt nie frei — der Verkäufer bestätigt auf seinem eigenen Kontoauszug |
| Verkäufer behauptet Nicht-Eingang | Schiedsverfahren; die Chain-Aufzeichnung und der Proof-Store sind die Beweise |
| Engine wird bösartig | Nur-Engine-Schritte benötigen die Engine-DID-Signatur; jeder Übergang wird verankert und ist öffentlich auditierbar |
| Streitfall | Beide Seiten können den Tausch einfrieren; die Token bleiben gesperrt, bis er geklärt ist |
| Refund | `expire` → `refund`, von Engine und Verkäufer mit-signiert — keine Zustimmung des Käufers, kein Timelock |

---

## Live gehen

Die Demo läuft gegen den In-Repo-Settlementservice mit einem Speicher-Store und
ohne Chain-Prüfung. Der echte Ablauf verdrahtet den Escrow-Signer mit dem
L0-Broadcast-Schritt und betreibt die Engine gegen L1-SOCIAL für das Orderbuch
und den Audit-Anker; der Käufer zahlt den Verkäufer direkt, und die Engine
signiert weiterhin immer nur mit.
