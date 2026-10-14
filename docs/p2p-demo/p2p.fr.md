# Règlement P2P — Swap en CNY avec libération confirmée par le vendeur

**Statut : build de démonstration + moteur en dépôt.** Tout ce qui suit est le flux de règlement tel que construit : séquestre P2SH 2-sur-3 sur Bigtangle L0 et une jambe CNY confirmée par le vendeur (WeChat Pay / Alipay / banque). Un virement personnel n'a pas d'événement de paiement vérifiable par machine, donc le propre relevé du vendeur constitue le signal fiat. Les captures proviennent du build de démonstration (stockage en mémoire, pas de contrôle de chaîne — les hachages de verrouillage/libération sont synthétiques). Le design se trouve dans `docs/p2p.md`.

Ce guide déroule la mise en vente d'USDT, l'appariement avec un acheteur, le verrouillage du séquestre, le paiement des CNY par l'acheteur **directement** au vendeur, la confirmation du vendeur sur son propre relevé, la libération du séquestre et le remboursement en cas de délai dépassé.

Pour le parcours combiné à trois rails (WeChat / Alipay / banque), voir [p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf`.

---

## 1. Le vendeur enregistre un profil de collecte

Le vendeur ouvre **P2P → Mes swaps**, choisit le rail (`wechat`) et saisit le nom et le compte de 收款. Le profil est stocké côté serveur sous le DID du vendeur et ne fait **pas** partie du carnet d'ordres public — il n'est révélé qu'à l'acheteur apparié.

![Le vendeur enregistre le profil de paiement WeChat](assets/screenshots/p2p-cny-wechat-01-profile-fr.png)

---

## 2. Le vendeur inscrit ses USDT

Soumet une ordre limite signée par DID au moteur de règlement :

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

L'ordre est validé contre la signature DID du vendeur. Statut : `ACTIVE` ; elle expire après `validUntil`.

![Inscrire une ordre de vente avec wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-fr.png)

---

## 3. L'acheteur apparie l'ordre

L'acheteur soumet un appariement signé par DID, en fournissant l'adresse qui doit recevoir la libération du séquestre. Il n'y a aucun compte/e-mail à collecter — rien sur le rail fiat n'est nécessaire au moment de l'appariement :

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

Statut : `MATCHED`. Un `swapId` unique est créé pour le cycle de vie et l'adresse de séquestre 2-sur-3 est dérivée des clés vendeur + acheteur + moteur.

![L'acheteur renseigne l'adresse de réception](assets/screenshots/p2p-cny-wechat-03-match-fr.png)

![Swap créé à MATCHED](assets/screenshots/p2p-cny-wechat-04-matched-fr.png)

---

## 4. Le vendeur verrouille ses USDT dans un séquestre 2-sur-3

L'adresse de séquestre est un script P2SH à trois clés — vendeur, acheteur, moteur — avec un seuil de deux :

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

Le moteur prouve le verrouillage avec `getTransactionStatus` — `CONFIRMED`, destination `escrowAddress`, montant 10 — et échoue en mode fermé si un contrôle ne tient pas. Statut : `ESCROW_LOCKED`. L'acheteur voit les fonds sécurisés avant de payer.

![Le vendeur colle le hachage de la tx de séquestre](assets/screenshots/p2p-cny-wechat-05-escrow-lock-fr.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-fr.png)

---

## 5. L'acheteur récupère les instructions de paiement

L'acheteur appuie sur **Détails du paiement**. Le moteur révèle le profil du vendeur, plus un **libellé par swap** que le virement *doit* porter, le montant exact et une échéance :

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

Statut : `PAYMENT_PENDING`. Un minuteur démarre — un swap impayé peut expirer et être remboursé sans le consentement de l'acheteur.

![Instructions de paiement : 户名, compte, 715 CNY, libellé](assets/screenshots/p2p-cny-wechat-08-instructions-fr.png)

---

## 6. L'acheteur paie les CNY et réclame avec le 流水号

L'acheteur vire `715 CNY` dans sa propre app WeChat, colle le numéro de transaction (流水号) dans **Transaction ID** et appuie sur **J'ai payé**. L'image de reçu facultative est stockée côté serveur ; seul son `sha256` est ancré sur l'événement du swap.

![Numéro de transaction (流水号) saisi](assets/screenshots/p2p-cny-wechat-09-payment-pending-fr.png)

Statut : `PAYMENT_CLAIMED` — les jetons sont toujours verrouillés. Cet état est la réclamation de l'acheteur et rien de plus.

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-fr.png)

---

## 7. Le vendeur confirme sur son propre relevé

La carte du vendeur affiche le 流水号 de l'acheteur et le libellé. Le vendeur vérifie **montant + libellé + heure + 流水号 sur son propre compte** (les captures ne comptent jamais) et n'appuie qu'ensuite sur **Confirmer la réception** :

![Le vendeur voit le 流水号 + l'avertissement de confirmation](assets/screenshots/p2p-cny-wechat-11-seller-confirm-fr.png)

Statut : `PAYMENT_VERIFIED`.

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-fr.png)

---

## 8. Le moteur et le vendeur libèrent le séquestre

Deux signatures satisfont le script : celle du vendeur (pré-signée au verrouillage, ou une co-signature) et celle du moteur. Aucune partie seule ne peut déplacer les fonds.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

La dépense de libération est assemblée et diffusée vers `receiveAddress`. Statut : `ESCROW_RELEASED`. L'acheteur détient les jetons ; comme le vendeur a déjà été payé en CNY, il n'y a pas d'étape de versement fiat — `complete` clôt le swap.

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-fr.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-fr.png)

---

## 9. Délai dépassé ou échec → remboursement

Si l'acheteur ne paie jamais, le moteur et le vendeur cosignent le même script en faveur du vendeur :

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Le remboursement ne demande ni consentement de l'acheteur ni time-lock — le seuil est atteint avec les deux autres clés. Statut : `EXPIRED` → `ESCROW_REFUNDED`. Aucune partie ne détient jamais les fonds de l'autre.

---

## 10. Vérification côté appareil — le téléphone du vendeur

Le relevé du vendeur est le reçu ; le moteur peut le lire automatiquement via
l'app du téléphone ([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp)).
WeChat masque son interface à l'accessibilité, donc pour WeChat l'app lit la
notification « 收款到账 » (pour Alipay/banque, l'écran).

L'appairage est un **code court à usage unique** affiché par l'app sur son écran
Serveur : saisissez l'endpoint et le code dans l'écran **Appareil** du
portefeuille (**Appairer avec le code**) ou la page **Mobile** de dai — l'app
renvoie un jeton par appareil (`POST /pair/claim`) ; révocation dans Réglages ›
Accès › Appareils appairés.

Avec `SETTLEMENT_CNY_AUTO_RELEASE_ON=seller_receipt`, le moteur peut confirmer
automatiquement sans le tap manuel.

## Comparaison : Binance P2P vs ce règlement

| Fonctionnalité | Binance P2P | Ce règlement |
|---|---|---|
| Vérification fiat | Le vendeur clique « Confirmer » (système d'honneur) | Le vendeur confirme sur son propre relevé ; le moteur applique le protocole |
| Custody fiat | P2P (acheteur → vendeur) | P2P (acheteur → vendeur) — le moteur ne touche jamais le fiat |
| Séquestre | Registre interne | P2SH 2-sur-3 sur Bigtangle L0 (vérifiable) |
| Remboursement | Ticket support | Moteur + vendeur cosignent, sans consentement de l'acheteur |
| Résolution de litige | Support humain (jours) | Preuve tx on-chain + magasin de preuves + libellé par swap (minutes) |

---

## Chronologie complète

```
MATCHED          14:20:00  Montant fixé à l'appariement
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMÉE à l'adresse 2-sur-3
PAYMENT_PENDING  14:24:00  instructions émises (compte + libellé f71ade2d23e9)
PAYMENT_CLAIMED  14:25:10  l'acheteur a collé le 流水号 4200001234567890
PAYMENT_VERIFIED 14:26:40  le vendeur a confirmé sur son propre relevé WeChat
ESCROW_RELEASED  14:27:20  vendeur + moteur ont cosigné la dépense vers receiveAddress
COMPLETED        14:27:21  pas de versement fiat — le vendeur détient déjà les CNY
```

---

## Flux de démonstration complet

```typescript
// 1. Le vendeur enregistre un profil de collecte en CNY  (POST /profiles)
// 2. Le vendeur soumet une ordre limite signée           (POST /orders)
// 3. L'acheteur apparie avec un match signé              (POST /orders/:id/match)
// 4. Le vendeur approvisionne le séquestre P2SH 2-sur-3 sur L0 ; le moteur le prouve (escrow_lock)
// 5. L'acheteur récupère les instructions de paiement    (POST /swaps/:id/payment-instructions)
// 6. L'acheteur paie dans WeChat et réclame le 流水号    (POST /swaps/:id/proof)
// 7. Le vendeur confirme sur son propre relevé           (POST /swaps/:id/confirm)
// 8. Vendeur + moteur cosignent la libération            (POST /swaps/:id/transitions, action: release)
// 9. Le moteur clôt le swap                              (…/transitions, action: complete)
```

Différence clé avec Binance P2P : les fonds reposent dans un script 2-sur-3 que ni l'une ni l'autre partie ne contrôle seule, chaque transition est ancrée sur L1-SOCIAL, et le propre relevé du vendeur — pas un ticket support — constitue la vérité fiat.
