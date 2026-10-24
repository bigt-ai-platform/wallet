# Predict-Demo — Märkte für Deutschland (Deutsch)

**Weitere Demos:** [USA (English)](predict.md) · [China (中文)](predict.zh.md) · Design und Bedrohungsmodell: [../prediction-market.md](../prediction-market.md)

Drei Beispielmärkte für ein deutsches Publikum, je einer pro Marktform, die
der **Predict**-Tab unterstützt:

1. ein **binärer** Markt mit 2-von-3-Komitee,
2. ein Markt mit **mehreren Ausgängen** (2–16) und Komitee,
3. ein Markt mit **Staked-Orakel**, bei dem jeder das Ergebnis vorschlagen kann.

Zu jedem Markt gibt es die exakten Werte für das Erstellformular, eine
schriftliche Auflösungsregel und den Ablauf bis zur Einlösung.

> **Testnet-Demo, kein Echtgeldangebot.** Die Sicherheit ist natives BIG (`bc`)
> auf der Test-Prediction-Chain. Echtgeld-Wetten auf Sportereignisse brauchen
> in Deutschland eine Erlaubnis nach dem Glücksspielstaatsvertrag 2021
> (Aufsicht: GGL). Ereigniskontrakte auf Wirtschaftsdaten können zudem unter
> Finanzmarktrecht (BaFin, MiFID II) fallen. Siehe
> [§8 des Designs](../prediction-market.md#8-out-of-scope).

---

## Voraussetzungen

- **PQ-Wallet (ML-DSA).** EC-Wallets werden bei Prediction-Aktionen abgelehnt.
- **BIG auf der Prediction-Chain.** Es dient für Gebühren und als Sicherheit.
  Die App hat noch keine Bridge-/Peg-in-Ansicht, daher finanziert ein
  Betreiber die Demo-Wallets auf der Prediction-Chain.
- **Markterstellung ist berechtigt.** Der Schlüssel des Erstellers muss die
  Token-Domain der Prediction-Chain signieren dürfen. Handeln, Auflösen,
  Anfechten, Abstimmen und Einlösen kann jede finanzierte PQ-Wallet.
- **Komitee-Adressen.** Für Komitee-Märkte die Hex-Adressen der Resolver
  sammeln. Bei 3 Resolvern braucht ein Ergebnis **2 übereinstimmende
  Auflösungen** (Mehrheit, `size/2 + 1`).
- **Einheiten.** Menge, Bonds und Orderbuch-Preise sind **rohe
  On-Chain-Einheiten**. Ein Gewinnanteil wird gegen genau eine Einheit
  Sicherheit eingelöst; der Preis relativ zu einer Einheit entspricht der
  implizierten Wahrscheinlichkeit. Die App rechnet nicht in Cent oder %.
- **Tagesangaben unten gelten für die Erstellung am 2026-10-23.** Das Feld
  „Resolution days“ akzeptiert Dezimalzahlen.

---

## Markt 1 — EZB-Zinsentscheid (binär, Komitee)

**Frage:** *Senkt die EZB den Einlagesatz auf ihrer ersten geldpolitischen
Sitzung im Jahr 2027?*

| Formularfeld | Wert |
|---|---|
| Question | `Senkt die EZB den Einlagesatz auf ihrer ersten geldpolitischen Sitzung im Jahr 2027?` |
| Outcomes | `JA` / `NEIN` (je eine Zeile) |
| Collateral | `bc` |
| Supply | `1000000` |
| Resolution days | `115` (→ 2027-02-15, nach der Pressemitteilung) |
| Dispute window (s) | `86400` (24 h) |
| Auto-invalid (s) | `2592000` (30 Tage) |
| Oracle | `committee` |
| Committee | 3 Resolver-Adressen, je eine Zeile |
| Bond (Dispute-Bond) | `1000` |

**Auflösungsregel.** **JA**, wenn die Pressemitteilung der EZB
(ecb.europa.eu) zur ersten planmäßigen geldpolitischen Sitzung 2027 eine
Senkung des Einlagesatzes verkündet; sonst **NEIN**. Eine außerplanmäßige
Entscheidung vor dieser Sitzung zählt nicht. Findet bis zum
Auflösungszeitpunkt keine planmäßige Sitzung statt, posten die Resolver
**INVALID**.

## Markt 2 — Deutscher Meister 2026/27 (mehrere Ausgänge, Komitee)

**Frage:** *Welcher Verein wird Deutscher Fußballmeister der Bundesliga-Saison 2026/27?*

| Formularfeld | Wert |
|---|---|
| Outcomes | `FC Bayern München` / `Borussia Dortmund` / `Bayer 04 Leverkusen` / `Anderer Verein` |
| Collateral / Supply | `bc` / `1000000` |
| Resolution days | `221` (→ 2027-06-01, nach dem 34. Spieltag) |
| Dispute window / Auto-invalid (s) | `86400` / `2592000` |
| Oracle / Committee / Bond | `committee` / 3 Adressen / `1000` |

**Auflösungsregel.** Maßgeblich ist die offizielle Abschlusstabelle der DFL
(bundesliga.com) nach dem letzten Spieltag. Jeder nicht genannte Verein
löst als `Anderer Verein` auf. Nachträgliche Punktabzüge nach dem
Auflösungszeitpunkt bleiben unberücksichtigt.

Outcome-Bezeichnungen dürfen keine Kommas enthalten, müssen eindeutig sein
und höchstens 40 Zeichen haben. Ein Split von C Sicherheit erzeugt C Anteile
**jedes** Ausgangs.

## Markt 3 — Inflation Dezember 2026 (binär, Staked-Orakel)

**Frage:** *Liegt die Inflationsrate in Deutschland (VPI, Veränderung zum
Vorjahresmonat) für Dezember 2026 laut Destatis unter 2,0 %?*

| Formularfeld | Wert |
|---|---|
| Outcomes | `JA` / `NEIN` |
| Collateral / Supply | `bc` / `1000000` |
| Resolution days | `89` (→ 2027-01-20, nach der endgültigen Veröffentlichung) |
| Dispute window (s) | `86400` |
| Auto-invalid (s) | `1209600` (14 Tage) |
| Oracle | `staked` (Committee leer lassen) |
| Bond (Proposal-Bond) | `5000` |
| Vote window (s) | `172800` (48 h) |

**Auflösungsregel.** Die **endgültigen** Destatis-Ergebnisse (nicht die
Schnellmeldung), wie veröffentlicht mit einer Nachkommastelle. **JA** nur
bei einem Wert strikt unter 2,0 %; genau 2,0 % ist **NEIN**.

---

## Ablauf (für alle drei Märkte gleich)

1. **Erstellen.** Predict-Tab → **Create market** → Werte aus der Tabelle →
   absenden. Die App erzeugt einen Token mit fester Menge pro Ausgang und den
   Vertrags-Token und legt die gesamte Menge in den Tresor (Vault) des
   Marktes. Der Markt erscheint als **OPEN**.
2. **Liquidität (Split).** Betrag eingeben und **Split** drücken: C BIG
   werden zu C Anteilen jedes Ausgangs. **Merge** macht das rückgängig,
   solange der Markt offen ist.
3. **Handeln.** Jeder Ausgang hat ein Orderbuch gegen BIG (bestes Gebot und
   Angebot mit Menge). **Buy**/**Sell** öffnet eine Vorschau mit
   geschätzter Ausführung, Limitpreis und Slippage (0–10 %, Standard 0,5 %).
   Ein Angebot verfällt nach 30 s, und das Buch wird beim Absenden neu
   gelesen. Es sind kreuzende Limit-Orders; nicht ausgeführte Reste bleiben
   im Buch.
4. **Auflösen.** Nach dem Auflösungszeitpunkt zeigt der Markt *resolution due*.
   - *Komitee (Märkte 1–2):* Jeder Resolver wählt den Ausgang. Stimmt die
     Mehrheit überein, wird der Markt **PENDING** und das Anfechtungsfenster
     beginnt.
   - *Staked (Markt 3):* Jeder kann einen Ausgang vorschlagen und hinterlegt
     mindestens den Proposal-Bond. Der Markt wird **PENDING**.
5. **Anfechten.** Während **PENDING** kann jeder mit Bond einen anderen
   Ausgang posten.
   - *Komitee:* Der Bond (≥ Dispute-Bond) geht an die Resolver, die
     Auflösungen werden gelöscht, und das Komitee löst erneut auf.
   - *Staked:* Ein Herausforderer (nicht der Vorschlagende) hinterlegt
     mindestens den Proposal-Bond. Der Markt wird **VOTING**, und Halter
     binden BIG für eine Seite während des Vote-Fensters. Die Seite mit mehr
     gebundenem Gewicht gewinnt; Gewinner erhalten ihren Einsatz zurück plus
     einen Anteil am Bond der Verlierer. Bei Gleichstand wird der Markt
     ungültig.
6. **Final.** Läuft das Fenster ohne Anfechtung ab, ist der Markt **FINAL**.
   Löst bis *Auflösungszeitpunkt + Auto-invalid* niemand auf, wird er
   **INVALID**.
7. **Einlösen.** In einem **FINAL**-Markt tauscht **Redeem** Gewinnanteile
   1:1 gegen BIG. In einem **INVALID**-Markt werden vollständige Sätze
   (ein Anteil jedes Ausgangs) gegen je 1 BIG getauscht; überzählige
   Einzelanteile bleiben in der Wallet.

Über die Filter **open / resolving / final / mine** und die Suche findet man
Märkte wieder. *Mine* zeigt die Märkte, in denen man Anteile hält.

## Checkliste für eigene deutsche Märkte

- **Eine Primärquelle** und die genaue Kennzahl nennen: Destatis, EZB oder
  DFL; Schnellmeldung oder endgültiger Wert.
- **Grenzen festlegen.** Wem gehört der exakte Grenzwert (z. B. „genau
  2,0 % ist NEIN“)?
- **Ausfall regeln.** Was passiert, wenn die Quelle verspätet ist oder
  fehlt: bis Auto-invalid warten oder INVALID?
- Den Auflösungszeitpunkt **nach** die Veröffentlichung legen und das
  Anfechtungsfenster lang genug für eine menschliche Prüfung wählen.

---

## Screenshots (lokale Test-Chain)

Erstellt mit `./e2e/e2etest.sh predict-demo` gegen die lokale
L1-Prediction-Chain.

### Markt 1 — EZB-Zinsentscheid

![Erstellformular: EZB](assets/screenshots/predict-de-1-create.png)

![Marktkarte: EZB](assets/screenshots/predict-de-1-market.png)

![Nach einem Split von 100000](assets/screenshots/predict-de-1-split.png)

### Markt 2 — Deutscher Meister 2026/27

![Erstellformular: Bundesliga](assets/screenshots/predict-de-2-create.png)

![Marktkarte: Bundesliga](assets/screenshots/predict-de-2-market.png)

### Markt 3 — Inflation Dezember 2026

![Erstellformular: VPI, Staked-Orakel](assets/screenshots/predict-de-3-create.png)

![Marktkarte: VPI](assets/screenshots/predict-de-3-market.png)

### Eigene Märkte

![Der Filter mine](assets/screenshots/predict-de-mine.png)
