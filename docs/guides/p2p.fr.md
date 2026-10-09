# Règlement P2P — échange inter-rails natif au wallet

**De quoi il s'agit.** Un échange pair à pair entre de la crypto sur
**Bigtangle L0** et de la monnaie fiat sur **PayPal** (ou les rails CNY — WeChat
Pay / Alipay / banque). Le vendeur place ses jetons sous séquestre dans une
**adresse P2SH 2-sur-3** (vendeur, acheteur, moteur) ; l'acheteur paie une
obligation fiat d'un **montant exact** ; le moteur prouve le paiement et libère
le séquestre. Chaque étape irréversible est signée avec la clé PQ du wallet, et le
moteur ne peut jamais que **co-signer** une dépense — il ne détient jamais vos
fonds.

**Où.** L'écran **P2P** du wallet (barre latérale → Trade → P2P). Tout ce qui suit
est capturé depuis cet écran dans la version de démonstration locale.

**Démo vs production.** Les captures proviennent de la démo : le moteur tourne en
mode PayPal simulé (URL de facture factices et hachages de transaction
synthétiques) et les étapes lock/verify/release sont signées par une clé de
moteur locale. La machine à états, les signatures, le journal d'événements en
append-only et l'ancrage d'audit on-chain sont réels ; seuls les appels PayPal
externes et la diffusion L0 sont simulés.

**Aucun « Confirmer » manuel.** Sur le rail PayPal, il n'y a pas de bouton
« Confirmer » côté vendeur — le moteur vérifie le paiement à partir de ses
propres preuves. (Les rails CNY, sans webhook, utilisent à la place une
confirmation explicite du vendeur ; voir `docs/p2pcny.md`.)

---

## Le flux en un coup d'œil

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Étape | Qui agit | On-chain / moteur |
|---|---|---|---|
| 1 | Le vendeur publie un ordre de vente signé | vendeur | ordre stocké, non financé |
| 2 | L'acheteur apparie (adresse de réception + compte PayPal) | acheteur | `swapId` créé, adresse de séquestre dérivée |
| 3 | Le vendeur finance le séquestre 2-sur-3, le moteur prouve le verrou | vendeur + moteur | `ESCROW_LOCKED` sur L0 |
| 4 | L'acheteur paie la facture exacte et la signale | acheteur | `PAYMENT_PENDING` |
| 5 | Le moteur vérifie lui-même le paiement | moteur | `PAYMENT_VERIFIED` |
| 6 | Moteur + acheteur co-signent la libération, les jetons bougent | moteur + acheteur | `ESCROW_RELEASED` |
| 7 | Le moteur paie le vendeur via PayPal Payouts | moteur | `COMPLETED` |

Chaque transition est ancrée comme un enregistrement `social.p2p-swap` sur la
chaîne L1-SOCIAL, de sorte que tout le cycle de vie est auditable publiquement
sans exposer les coordonnées PayPal de l'une ou l'autre partie.

---

## 1. Le vendeur publie un ordre de vente

Dans l'onglet **Open sells**, remplissez l'ordre : le jeton et le montant que
vous donnez, le prix fiat souhaité, la devise, la chaîne du jeton et le
**moyen de paiement** (PayPal ou un rail CNY). Les conditions sont figées dans
l'ordre à la publication ; cette étape est donc signée avec votre clé de wallet.

![Le formulaire d'ordre de vente, rail PayPal sélectionné](/demo/p2p/p2p-01-order-fr.png)

Une fois publié, l'ordre est `ACTIVE` dans le moteur et apparaît dans le carnet
d'ordres public (sans données personnelles) :

![L'ordre est visible dans le carnet](/demo/p2p/p2p-02-active-fr.png)

---

## 2. L'acheteur apparie

L'acheteur ouvre l'ordre et fournit l'**adresse de réception** des jetons libérés
ainsi que le **compte PayPal** à facturer (et un e-mail pour la facture).
L'appariement engage l'acheteur à payer, il est donc signé lui aussi :

![L'acheteur saisit l'adresse de réception et le compte PayPal](/demo/p2p/p2p-03-match-fr.png)

Le moteur crée un `swapId` unique pour le cycle de vie et l'échange passe à
`MATCHED`, visible dans l'onglet **My swaps** de l'acheteur :

![L'échange est MATCHED](/demo/p2p/p2p-04-matched-fr.png)

---

## 3. Verrouillage du séquestre — le vendeur finance L0

Le vendeur envoie les jetons à l'adresse de séquestre déterministe 2-sur-3 et
signale le `txHash` du transfert. Le moteur prouve le verrou depuis la chaîne
(`CONFIRMED`, destination `escrowAddress`, montant) et échoue si une vérification
ne tient pas. L'échange est désormais `ESCROW_LOCKED` :

![Le vendeur verrouille le séquestre](/demo/p2p/p2p-05-escrow-locked-fr.png)

L'acheteur voit les fonds sécurisés **avant** d'envoyer le moindre fiat, et
obtient une action **I have paid** (J'ai payé) une fois le verrou prouvé :

![L'acheteur voit le séquestre verrouillé](/demo/p2p/p2p-06-buyer-locked-fr.png)

---

## 4. L'acheteur paie

L'acheteur paie la facture PayPal hébergée (PayPal détient l'argent — jamais le
moteur) et signale le paiement. Ce n'est qu'un *indice* ; la vraie vérification
est la preuve propre au moteur. L'échange est `PAYMENT_PENDING`, et un minuteur
de délai démarre — si la facture n'est jamais payée, le vendeur peut expirer et
rembourser le séquestre sans l'accord de l'acheteur :

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-fr.png)

---

## 5. Le moteur vérifie le paiement

Aucune confirmation du vendeur n'intervient. Le moteur contrôle le paiement
depuis sa propre source et fait passer l'échange à `PAYMENT_VERIFIED` — le
séquestre peut désormais être libéré vers l'adresse de réception de l'acheteur :

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-fr.png)

---

## 6. Libération — les fonds bougent

La libération déplace les jetons sous séquestre : le moteur et l'acheteur
signent chacun une dépense de la sortie de séquestre, et deux signatures
satisfont le script 2-sur-3. Les jetons arrivent à l'adresse de réception de
l'acheteur et l'échange est `ESCROW_RELEASED` :

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-fr.png)

---

## 7. Versement — le vendeur reçoit le fiat

La dernière étape paie le vendeur via PayPal Payouts, et l'échange atteint
`COMPLETED` :

![COMPLETED](/demo/p2p/p2p-10-completed-fr.png)

Le résultat du versement (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) arrive par
webhook PayPal ou est interrogé en secours ; un échec peut être réessayé depuis
`COMPLETED` sans refaire l'échange.

---

## Ce qui vous protège

| Risque | Mesure |
|---|---|
| La contrepartie se retire | Les fonds sont dans une adresse P2SH 2-sur-3 ; personne ne peut les bouger seul |
| Sous- ou surpaiement | La facture est d'un montant exact : elle est payée en totalité ou pas du tout |
| Fausse déclaration de paiement | Le moteur vérifie le paiement lui-même — le payeur ne peut pas se l'attribuer |
| Moteur malveillant | Les étapes réservées au moteur exigent la signature DID du moteur ; chaque transition est ancrée et publiquement auditable |
| Rétrofacturation après libération | `PAYMENT.CAPTURE.REVERSED` déclenche un gel : les étapes en avant s'arrêtent, remboursement/expiration restent possibles |
| Litige | `CUSTOMER.DISPUTE.*` met l'échange en pause jusqu'à résolution |
| Échec de versement | `HELD`/`FAILED`/`BLOCKED` sont des états de premier ordre ; réessayer avec la même référence de versement |

---

## Passer en production

La démo tourne contre le service de règlement du dépôt avec PayPal simulé. Pour
le flux réel, il faut un compte business PayPal avec les Payouts activés, ses
identifiants API et son webhook id, et le signataire de séquestre relié à l'étape
de diffusion L0. D'ici là, le moteur exécute la même machine à états sans toucher
à de l'argent réel.
