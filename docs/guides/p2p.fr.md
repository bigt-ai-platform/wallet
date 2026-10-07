# Règlement P2P — Swap entre rails avec vérification IA

**Statut : conception cible, non construite.** Tout ce qui suit décrit le flux de règlement que nous construisons : séquestre P2SH 2-sur-3 sur Bigtangle L0 et vérification réelle via l'API PayPal. La version de démonstration actuelle est une machine à états sur Postgres avec une jambe fiat simulée. Les captures d'écran proviennent de cette version ; le design se trouve dans le dépôt dai, `docs/p2p.md`.

Ce guide présente le flux de règlement P2P natif IA : inscription d'une annonce de vente d'USDT, appariement avec un acheteur, verrouillage du séquestre, paiement fiat avec vérification automatique, libération du séquestre et remboursement en cas de délai dépassé. Aucun bouton « Confirmer » manuel — le moteur de règlement vérifie le paiement à partir d'un webhook PayPal.

---

## 1. Vue du tableau de bord

Le tableau de bord P2P affiche tous les swaps actifs avec leur statut, leur taux et leurs références de transaction.

![Tableau de bord](demo-output/screenshots/p2p-dashboard-fr.png)

Le tableau de bord affiche tous les swaps actifs avec leur statut, leur taux et leurs références de transaction. Chaque carte affiche l'ID du swap, la paire d'actifs (ex. 100 USDT ⇄ 101 USD), un badge de statut en couleurs et une chronologie dépliable.

---

## 2. Le vendeur inscrit ses USDT

Soumet une ordre limite signée par DID au moteur de règlement.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

Le vendeur soumet une ordre limite signée : vendre 100 USDT pour 101 USD via PayPal. Le moteur de règlement valide la signature DID. Statut : ACTIVE. L'ordre expire après validUntil.

---

## 3. L'acheteur apparie l'ordre

L'acheteur soumet une ordre de marché signée. Le taux est verrouillé au moment de l'appariement via un oracle, et le montant de la facture est fixé dès cet instant.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

L'acheteur apparie l'ordre avec une ordre de marché signée par DID, en fournissant l'adresse qui doit recevoir la libération du séquestre et le compte PayPal à créditer. Statut : MATCHED. Un swapId unique est créé pour le cycle de vie.

---

## 4. Le vendeur verrouille ses USDT dans un séquestre 2-sur-3

L'adresse de séquestre est un script P2SH à trois clés — vendeur, acheteur, moteur — avec un seuil de deux.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

Le vendeur approvisionne l'adresse de séquestre sur Bigtangle L0. Le moteur prouve le verrouillage avec `getTransactionStatus` — `CONFIRMED`, destination `escrowAddress`, montant 100 — et échoue en mode fermé si l'une des trois vérifications ne tient pas. Statut : ESCROW_LOCKED. L'acheteur voit les fonds sécurisés avant d'envoyer le fiat.

---

## 5. Le moteur émet la facture, l'acheteur paie via PayPal

Le moteur crée une facture PayPal d'un montant exact et remet l'URL hébergée à l'acheteur.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → URL de paiement hébergée ; numéro de facture = swapId
```

L'acheteur paie la facture hébergée. Le moteur ne touche pas l'argent — PayPal le détient. Aucune confirmation du vendeur nécessaire. Statut : PAYMENT_PENDING. Le minuteur de délai démarre.

---

## 6. Le moteur vérifie automatiquement le paiement

**Innovation clé** : aucun bouton humain « Confirmer ». Le paiement est prouvé par PayPal, pas affirmé par une partie.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

Le moteur vérifie le webhook `INVOICING.INVOICE.PAID`, dédupliqué sur `event.id`. Cela remplace le bouton manuel « Confirmer » de Binance P2P. Aucun vendeur ne peut nier la réception. Statut : PAYMENT_VERIFIED.

---

## 7. Le moteur et l'acheteur libèrent le séquestre

Deux signatures satisfont le script : celle de l'acheteur et celle du moteur. Aucune partie seule ne peut déplacer les fonds.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

La dépense de libération est assemblée et diffusée vers `receiveAddress`. Statut : ESCROW_RELEASED. L'acheteur détient désormais les jetons ; le travail restant du moteur est le versement fiat.

---

## 8. Le moteur verse le vendeur

Le moteur envoie des USD au compte PayPal du vendeur via Payouts v1, de façon idempotente par swap.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

Le moteur envoie des USD au compte PayPal du vendeur. Swap COMPLETED. Durée totale : ~3-5 minutes. Tout est signé par DID, chaque étape est auditable sur la chaîne ou chez PayPal.

---

## 9. Délai dépassé ou échec → remboursement

Si la facture n'est jamais payée, le moteur et le vendeur cosignent le même script en faveur du vendeur.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Le remboursement ne demande ni consentement de l'acheteur ni time-lock — le seuil est atteint avec les deux autres clés. Statut : EXPIRED → ESCROW_REFUNDED. Aucune partie ne détient jamais les fonds de l'autre.

---

## 10. Vue de l'historique

Les swaps terminés, expirés et annulés sont visibles dans la page d'historique.

![Historique](demo-output/screenshots/p2p-history-fr.png)

La page d'historique liste les swaps terminés, expirés et annulés. Chaque entrée affiche la paire d'actifs, le statut final, les étapes de la chronologie et les DID des parties.

---

## Comparaison : Binance P2P vs règlement IA

| Fonctionnalité | Binance P2P | Règlement IA |
|---------|-------------|---------------|
| Vérification fiat | Le vendeur clique « Confirmer » (honneur) | Webhook PayPal, vérifié RSA (déterministe) |
| Custody fiat | P2P (acheteur → vendeur) | PayPal détient jusqu'au versement (acheteur → PayPal → vendeur) |
| Séquestre | Registre interne | P2SH 2-sur-3 sur Bigtangle L0 (vérifiable) |
| Remboursement | Ticket support | Moteur + vendeur cosignent, sans consentement de l'acheteur |
| Résolution de litige | Support humain (jours) | Preuve tx on-chain + événement PayPal (minutes) |

---

## Chronologie complète

```
MATCHED          14:20:00  Taux verrouillé, montant de facture fixé
ESCROW_LOCKED    14:23:15  Tx L0 CONFIRMÉE sur l'adresse 2-sur-3
PAYMENT_PENDING  14:24:00  Facture INV-7f3c91 émise
PAYMENT_VERIFIED 14:24:10  Webhook INVOICING.INVOICE.PAID, vérifié RSA
ESCROW_RELEASED  14:24:30  Dépense cosignée vers receiveAddress
COMPLETED        14:25:00  Lot de versement PAYOUT-abc SUCCESS
```

---

## Flux de démonstration complet

```typescript
// 1. Le vendeur soumet une ordre limite signée (POST /api/p2p/orders)
// 2. L'acheteur apparie avec une ordre de marché signée (POST /api/p2p/orders/:id/match)
// 3. Le vendeur approvisionne le séquestre P2SH 2-sur-3 sur L0 ; le moteur le prouve (getTransactionStatus)
// 4. Le moteur émet une facture PayPal ; l'acheteur paie (POST /api/p2p/payments/invoice)
// 5. Le moteur vérifie le webhook INVOICING.INVOICE.PAID (POST /api/webhooks/paypal)
// 6. Moteur + acheteur cosignent la dépense de libération (POST .../transitions, action: release)
// 7. Le moteur verse le vendeur (POST /api/p2p/payments/payout)
// 8. Les deux parties voient le statut COMPLETED sur le tableau de bord
```

Différence clé avec Binance P2P : **pas de bouton « Confirmer » côté vendeur.** Le paiement est prouvé par un webhook PayPal et les fonds reposent dans un script 2-sur-3 que ni l'une ni l'autre des parties ne contrôle seule — déterministe, auditable, instantané.
