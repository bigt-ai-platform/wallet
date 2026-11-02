# FIAT (Fiat-Währung) Abwicklung — BIG mit WeChat / Alipay / Bank oder PayPal tauschen

**Begriffe.** FIAT = Fiat-Währung; CNY = chinesischer Yuan; USD = US-Dollar; P2P = Peer-to-Peer.

**Worum es geht.** In der Bigtangle Wallet tauschst du **BIG** direkt gegen Fiat-Währung (WeChat Pay / Alipay / Bank oder **PayPal USD**). Die BIG des Verkäufers kommen zuerst in eine **Treuhandadresse**, über die nur mit Zustimmung von zwei der drei Seiten — Verkäufer, Käufer und Plattform — verfügt werden kann. Der Käufer zahlt das Geld direkt an den Verkäufer; nachdem der Verkäufer den Eingang auf seinem eigenen Kontoauszug bestätigt hat, gibt er die BIG frei. Die Plattform verwahrt dein Geld nicht und berührt die Fiat-Währung nicht.

**Zu den Screenshots.** Die Screenshots unten stammen aus einer Demo-Umgebung auf einem echten Gerät; Beträge und Hash-Werte sind Demodaten, es ist kein echtes Geld im Spiel.

Diese Anleitung zeigt: Ein Verkäufer stellt BIG zum Verkauf ein, ein Käufer kauft, die Treuhand wird gesperrt, der Käufer zahlt, der Verkäufer bestätigt, die BIG werden freigegeben, und bei Zeitüberschreitung gibt es eine Rückerstattung. Wechselkurs **BIG/CNY = 0.01**, Order **10,000 BIG → 100 CNY**.

## Ablauf im Überblick

```
Ausstehendes Match → Zugeordnet → Treuhand gesperrt → Zahlung ausstehend → Zahlung gemeldet → Zahlung bestätigt → Treuhand freigegeben → Abgeschlossen
```

Jeder Schritt erscheint auf der Transaktionskarte in der App; der Status läuft nur vorwärts und wird weder übersprungen noch zurückgesetzt.

Optionaler Weg: Wenn es nach der Zahlung Streit zwischen beiden Seiten gibt, kann die Transaktion eingefroren und ein Streitfall eingereicht werden, den die Plattform unterstützend entscheidet (BIG an den Käufer freigeben oder Geld an den Verkäufer erstatten).


**PayPal (US-Dollar).** Wenn du **PayPal** wählst, wechselt die Fiat-Währung automatisch auf **USD** und das Empfangskonto wird zur PayPal-E-Mail-Adresse; der restliche Ablauf bleibt völlig gleich. Die vollständige Demo steht in [p2p-paypal.zh.md](p2p-paypal.zh.md) → `assets/p2p-paypal.zh.mobile.pdf` (**10,000 BIG → 100 USD**).



---

## 1. Verkäufer speichert ein Zahlungsprofil

Der Verkäufer öffnet **P2P → Meine Transaktionen** und wählt die Zahlungsmethode (WeChat, Alipay, Bank oder PayPal); dann trägt er Kontoinhaber und Kontonummer ein (bei PayPal die E-Mail-Adresse). Diese Angaben werden dem Käufer erst nach dem Match gezeigt und erscheinen nicht im öffentlichen Orderbuch.

![Verkäufer speichert das WeChat-Pay-Profil](assets/screenshots/p2p-cny-wechat-01-profile-de.png)

---

## 2. Verkäufer stellt BIG zum Verkauf ein

Der Verkäufer trägt unter **Verkaufsorder veröffentlichen** den Token (`bc`), die Menge **10,000**, den Preis **0.01**, die Fiat-Währung **CNY** und die Zahlungsmethode **WeChat** ein und veröffentlicht die Order.

Nach dem Veröffentlichen erscheint die Verkaufsorder im öffentlichen Orderbuch mit dem Status **Ausstehendes Match**. Eine noch nicht gematchte Verkaufsorder kann der Verkäufer jederzeit zurückziehen.

![Eine Verkaufsorder mit wechat / CNY einstellen](assets/screenshots/p2p-cny-wechat-02-order-de.png)

---

## 3. Käufer matcht die Order

Der Käufer öffnet die Verkaufsorder, trägt die Adresse für den BIG-Empfang ein und bestätigt den Kauf. WeChat- oder Alipay-Konto müssen hier noch nicht angegeben werden — die Zahlungsinformationen des Verkäufers werden diesem Käufer erst nach dem Sperren der Treuhand separat angezeigt.

Die App legt für diese Transaktion eine eindeutige Transaktionsnummer an und bereitet die Treuhandadresse vor; der Status wechselt auf **Zugeordnet**.

![Käufer trägt die Empfangsadresse ein](assets/screenshots/p2p-cny-wechat-03-match-de.png)

![Swap bei Zugeordnet erstellt](assets/screenshots/p2p-cny-wechat-04-matched-de.png)

---

## 4. Verkäufer sperrt die BIG in der Treuhand

Die App erzeugt für diese Transaktion eine **2-von-3-Treuhandadresse**: Nur wenn zwei der drei Seiten — Verkäufer, Käufer und Plattform — zustimmen, kann über das Geld verfügt werden; keine Seite kann es allein entnehmen.

Der Verkäufer überweist **10,000 BIG** an diese Adresse und fügt den Hash dieser Überweisung in die App ein. Nachdem die App Betrag und Empfangsadresse geprüft hat, wechselt der Status auf **Treuhand gesperrt**. Der Käufer sieht schon vor der Fiat-Zahlung, dass die BIG gesperrt sind.

![Verkäufer fügt den Hash der Treuhand-Überweisung ein](assets/screenshots/p2p-cny-wechat-05-escrow-lock-de.png)

![Treuhand gesperrt](assets/screenshots/p2p-cny-wechat-06-escrow-locked-de.png)

---

## 5. Käufer ruft die Zahlungsanweisungen ab

Der Käufer tippt auf **Zahlungsdetails** und sieht:

- den Kontoinhaber des Verkäufers
- das Empfangskonto (WeChat- / Alipay- / Bankkonto oder PayPal-E-Mail-Adresse)
- den genauen Betrag **100 CNY**
- einen **Verwendungszweck**, der nur zu dieser Transaktion gehört
- die Zahlungsfrist

Beim Überweisen muss der Käufer den Verwendungszweck als Notiz angeben. Der Status wechselt auf **Zahlung ausstehend**; wird die Frist ohne Zahlung überschritten, verfällt die Transaktion und wird erstattet.

![Zahlungsanweisung: Kontoinhaber, Konto, 100 CNY, Verwendungszweck](assets/screenshots/p2p-cny-wechat-08-instructions-de.png)

---

## 6. Käufer zahlt CNY und meldet die Zahlung

Der Käufer überweist **100 CNY** in seiner eigenen WeChat-App, trägt den Verwendungszweck als Notiz ein, fügt danach die Transaktionsnummer in **Transaktionsnummer** ein und tippt auf **Ich habe bezahlt**.

Optional lässt sich ein Bild als Zahlungsbeleg anhängen; das Bild wird nur auf dem Server gespeichert und nicht in die Blockchain geschrieben.

![Transaktionsnummer eingegeben](assets/screenshots/p2p-cny-wechat-09-payment-pending-de.png)

Der Status wechselt auf **Zahlung gemeldet**. Die BIG bleiben weiterhin gesperrt; das ist nur die Zahlungsmeldung des Käufers.

![Zahlung gemeldet](assets/screenshots/p2p-cny-wechat-10-payment-claimed-de.png)

---

## 7. Verkäufer bestätigt auf dem eigenen Kontoauszug

Die Transaktionskarte des Verkäufers zeigt die vom Käufer eingetragene Transaktionsnummer und die Notiz. Der Verkäufer prüft ausschließlich im eigenen WeChat-Kontoauszug **Betrag + Verwendungszweck + Zeit + Transaktionsnummer** und tippt erst nach einwandfreier Prüfung auf **Zahlungseingang bestätigen**.

Screenshots gelten nicht als Beleg; maßgeblich ist der tatsächliche Eingang auf dem eigenen Konto.

![Verkäufer sieht Transaktionsnummer + Bestätigungswarnung](assets/screenshots/p2p-cny-wechat-11-seller-confirm-de.png)

Der Status wechselt auf **Zahlung bestätigt**.

![Zahlung bestätigt](assets/screenshots/p2p-cny-wechat-12-payment-verified-de.png)

---

## 8. Verkäufer gibt die Treuhand frei

> **Verkäufer, bitte gib die Treuhand zügig frei.** Nach der Bestätigung des Zahlungseingangs solltest du sofort auf **Mittel freigeben** tippen. Verzögerte Freigaben senken die Bewertung des Verkäufers; bei schweren oder wiederholten Verzögerungen wird der Verkäufer als **unsicher** markiert, was sich auf künftige Orders auswirkt.

Der Verkäufer tippt nach der Bestätigung des Zahlungseingangs sofort auf **Mittel freigeben**, die Plattform signiert mit, und die BIG gehen an die Empfangsadresse des Käufers. Die Signatur des Verkäufers und die der Plattform genügen für die Freigabe; keine Seite kann das Geld allein bewegen.

Da der Verkäufer das Fiat direkt erhalten hat, gibt es keinen weiteren Fiat-Auszahlungsschritt, und die Transaktion ist damit beendet.

![Treuhand freigegeben](assets/screenshots/p2p-cny-wechat-13-escrow-released-de.png)

![Abgeschlossen](assets/screenshots/p2p-cny-wechat-14-completed-de.png)

Der Status wechselt auf **Abgeschlossen**.

---

## 9. Optional: Streitfall mit Unterstützung der Plattform

Wenn es Streit über die Zahlung gibt (Betrag weicht ab, Geld nicht angekommen, Verkäufer gibt trotz Bestätigung nicht frei usw.), kann jede Seite die Transaktion einfrieren und einen Streitfall einreichen. Die Plattform prüft Treuhand und Zahlungsbelege und entscheidet dann, **die BIG an den Käufer freizugeben** oder **das Geld an den Verkäufer zu erstatten**.

Niederlagen und wiederholte Verzögerungen des Verkäufers werden in der Reputation erfasst; in schweren Fällen wird er als **unsicher** markiert.

---

## 10. Zeitüberschreitung oder Fehlschlag → Rückerstattung

Wenn der Käufer gar nicht zahlt, kann der Verkäufer die Transaktion verfallen lassen; die in der Treuhand gesperrten BIG gehen an den Verkäufer zurück, ohne dass der Käufer zustimmen muss.

Keine Seite hält jemals das Geld der anderen.

---

## 11. Optional: „Mit meinem Telefon verifizieren“ (Käufer, verzögerte Freigabe)

Das ist kein notwendiger Schritt der normalen Abwicklung. Der Käufer sieht **„Mit meinem Telefon verifizieren“** nur dann, wenn der Verkäufer die Freigabe verzögert (mehr als **30 Minuten** nach der Zahlungsmeldung des Käufers, oder nach der Bestätigung ohne Freigabe) **oder** wenn ein Streitfall eröffnet wurde.

Der Schritt erscheint nur bei **Alipay / Bank**, weil die Käuferseite die Überweisungsaufzeichnungen lesen kann; WeChat benachrichtigt nur den Empfänger, und PayPal hat keine Lesebrücke, deshalb erscheint er dort nicht. Der Käufer liest einmal mit seinem gekoppelten Telefon, die Wallet signiert das Ergebnis und reicht es ein; die Prüfung fließt in die Reputation des Verkäufers ein, kann aber die Freigabe nicht ersetzen, die der Verkäufer zügig vornehmen soll.

---

## Vergleich: Binance P2P und diese Abwicklung

| Funktion | Binance P2P | Diese Abwicklung |
|---|---|---|
| Fiat-Prüfung | Verkäufer klickt „Bestätigen“ (Reputationssystem) | Verkäufer bestätigt auf dem eigenen Kontoauszug, die Plattform gibt die BIG nach dem Ablauf frei |
| Fiat-Verwahrung | Plattform (Käufer → Verkäufer) | Käufer zahlt direkt an den Verkäufer, die Plattform berührt das Fiat nie |
| Treuhand | internes Konto der Plattform | 2-von-3-Treuhand on-chain, öffentlich einsehbar |
| Rückerstattung | Support-Ticket | abgelaufene Transaktion geht automatisch an den Verkäufer zurück |
| Streitbeilegung | menschlicher Support (mehrere Tage) | Streitfall in der App + Entscheidung der Plattform (schneller) |

---

## Zeitleiste

```
Zugeordnet           14:20  Betrag wird beim Match festgelegt
Treuhand gesperrt    14:23  Verkäufer überweist BIG, App bestätigt den Eingang
Zahlung ausstehend   14:24  Käufer sieht die Zahlungsanweisungen
Zahlung gemeldet     14:25  Käufer zahlt und trägt die Transaktionsnummer ein
Zahlung bestätigt    14:26  Verkäufer bestätigt auf dem eigenen Kontoauszug
Treuhand freigegeben 14:27  Verkäufer und Plattform signieren gemeinsam, BIG gehen an den Käufer
Abgeschlossen        14:27  Transaktion beendet
```

---

Wenn dich die Umsetzungsdetails zu Statusmaschine, Signaturen, Treuhandskript und Schnittstellen interessieren, lies die Entwicklerdokumentation `docs/p2p.md`.
