# Règlement P2P — échange CNY natif au wallet

**De quoi il s'agit.** Un échange pair à pair entre de la crypto sur
**Bigtangle L0** et de la monnaie fiat CNY (WeChat Pay / Alipay / banque). Le
vendeur place ses jetons sous séquestre dans une **adresse P2SH 2-sur-3**
(vendeur, acheteur, moteur) ; l'acheteur paie le vendeur **directement** dans sa
propre application de paiement ; le vendeur confirme la réception sur son propre
relevé et le séquestre est libéré. Chaque étape irréversible est signée avec la
clé PQ du wallet, et le moteur ne peut jamais que **co-signer** une dépense — il
ne détient jamais vos fonds et ne touche jamais au fiat.

**Où.** L'écran **P2P** du wallet (barre latérale → Trade → P2P). Tout ce qui suit
est capturé depuis cet écran dans la version de démonstration locale.

**Démo vs production.** Les captures proviennent de la démo : le moteur tourne
avec un stockage en mémoire et sans contrôle de chaîne, donc les étapes
lock/release utilisent des hachages de transaction synthétiques. La machine à
états, les signatures, le journal d'événements en append-only et l'ancrage
d'audit on-chain sont réels ; seule la diffusion L0 est simulée.

**La confirmation du vendeur est le signal fiat.** Il n'existe pas d'API de
collecte pour un compte personnel WeChat/Alipay/banque, donc il n'y a aucun
événement de paiement vérifiable par machine à attendre. Le vendeur vérifie
**montant + motif + heure + 流水号 dans sa propre application** — une capture
d'écran ne compte jamais — puis confirme. Les détails de conception se trouvent
dans `docs/p2p.md`.

---

## Le flux en un coup d'œil

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──instructions──▶ PAYMENT_PENDING
                                                                          │
   PAYMENT_PENDING ──proof──▶ PAYMENT_CLAIMED ──confirm──▶ PAYMENT_VERIFIED
                                                                  │
                            PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──complete──▶ COMPLETED
```

| # | Étape | Qui agit | On-chain / moteur |
|---|---|---|---|
| 1 | Le vendeur enregistre un profil de collecte CNY | vendeur | profil stocké côté serveur, jamais dans le carnet |
| 2 | Le vendeur publie un ordre de vente signé | vendeur | ordre stocké, non financé |
| 3 | L'acheteur apparie (adresse de réception) | acheteur | `swapId` créé, adresse de séquestre dérivée |
| 4 | Le vendeur finance le séquestre 2-sur-3, le moteur prouve le verrou | vendeur + moteur | `ESCROW_LOCKED` sur L0 |
| 5 | L'acheteur récupère les instructions de paiement | acheteur | `PAYMENT_PENDING` (+ motif par échange) |
| 6 | L'acheteur paie dans sa propre application et réclame avec le 流水号 | acheteur | `PAYMENT_CLAIMED` |
| 7 | Le vendeur vérifie son propre relevé et confirme | vendeur | `PAYMENT_VERIFIED` |
| 8 | Le moteur libère les jetons, l'échange se termine | moteur | `ESCROW_RELEASED` → `COMPLETED` |

Chaque transition est ancrée comme un enregistrement `social.p2p-swap` sur la
chaîne L1-SOCIAL, de sorte que tout le cycle de vie est auditable publiquement
sans exposer les coordonnées de compte de l'une ou l'autre partie.

---

## 1. Le vendeur enregistre un profil de collecte

Dans l'onglet **My swaps**, le vendeur choisit un rail (WeChat, Alipay ou
banque) et saisit le nom de 收款 et le compte. Le profil est stocké côté serveur
sous le DID du vendeur et ne fait **pas** partie du carnet d'ordres public — il
n'est révélé qu'à l'acheteur apparié par l'appel d'instructions.

![Le vendeur enregistre le profil de paiement WeChat](/demo/p2p/p2p-cny-wechat-01-profile-fr.png)

---

## 2. Le vendeur publie un ordre de vente

Dans l'onglet **Open sells**, remplissez l'ordre : le jeton et le montant que
vous donnez, le prix en CNY souhaité, la chaîne sur laquelle se trouvent les
jetons et le **moyen de paiement** (wechat / alipay / bank). Sélectionner un rail
CNY bascule la devise sur CNY. Les conditions sont figées dans l'ordre à la
publication ; cette étape est donc signée avec votre clé de wallet :

![Le formulaire d'ordre de vente avec le rail wechat](/demo/p2p/p2p-cny-wechat-02-order-fr.png)

Une fois publié, l'ordre est `ACTIVE` dans le moteur et apparaît dans le carnet
d'ordres public (il ne porte aucun détail personnel).

---

## 3. L'acheteur apparie

L'acheteur ouvre l'ordre et fournit l'**adresse de réception** des jetons
libérés. L'appariement engage l'acheteur à payer, il est donc signé lui aussi :

![L'acheteur saisit l'adresse de réception](/demo/p2p/p2p-cny-wechat-03-match-fr.png)

Le moteur crée un `swapId` unique pour le cycle de vie et l'échange passe à
`MATCHED`, visible dans l'onglet **My swaps** de l'acheteur :

![L'échange est MATCHED](/demo/p2p/p2p-cny-wechat-04-matched-fr.png)

---

## 4. Verrouillage du séquestre — le vendeur finance L0

Le vendeur envoie les jetons à l'adresse de séquestre déterministe 2-sur-3 et
signale le `txHash` du transfert. Le moteur prouve le verrou depuis la chaîne
(`CONFIRMED`, destination `escrowAddress`, montant) et échoue si une vérification
ne tient pas :

![Le vendeur colle le hachage de transaction du séquestre](/demo/p2p/p2p-cny-wechat-05-escrow-lock-fr.png)

L'échange est désormais `ESCROW_LOCKED`. L'acheteur voit les fonds sécurisés
**avant** d'envoyer le moindre fiat, et obtient une action **Payment details**
(Détails du paiement) :

![ESCROW_LOCKED](/demo/p2p/p2p-cny-wechat-06-escrow-locked-fr.png)

---

## 5. L'acheteur récupère les instructions de paiement

L'acheteur appuie sur **Payment details** (Détails du paiement) ; le moteur
révèle le profil du vendeur et génère un **code de motif par échange** que le
transfert *doit* porter, ainsi que le montant exact et une échéance. Les
instructions s'affichent en ligne dans la carte d'échange :

![Instructions de paiement : 户名, compte, 715 CNY, motif](/demo/p2p/p2p-cny-wechat-08-instructions-fr.png)

L'échange est `PAYMENT_PENDING`, et un délai démarre — si l'acheteur ne paie
jamais, le vendeur peut expirer et rembourser le séquestre sans l'accord de
l'acheteur.

---

## 6. L'acheteur paie et réclame avec le 流水号

L'acheteur transfère le montant exact dans sa propre application
WeChat/Alipay/banque, colle le numéro de transaction (流水号) dans
**Transaction ID** et appuie sur **I have paid** (J'ai payé). Une image de reçu
facultative est stockée côté serveur ; seul son `sha256` est ancré sur
l'événement d'échange :

![Transaction ID (流水号) saisi](/demo/p2p/p2p-cny-wechat-09-payment-pending-fr.png)

Le statut est désormais `PAYMENT_CLAIMED` — **les jetons sont toujours
verrouillés.** Cet état n'existe que comme déclaration de l'acheteur :

![PAYMENT_CLAIMED](/demo/p2p/p2p-cny-wechat-10-payment-claimed-fr.png)

---

## 7. Le vendeur confirme sur son propre relevé

La carte du vendeur affiche le 流水号 de l'acheteur et le motif. Le vendeur
vérifie **montant + motif + heure + 流水号 sur son propre compte** et n'appuie
qu'ensuite sur **Confirm received** (Confirmer la réception) :

![Le vendeur voit le 流水号 et l'avertissement de confirmation](/demo/p2p/p2p-cny-wechat-11-seller-confirm-fr.png)

L'échange est `PAYMENT_VERIFIED` :

![PAYMENT_VERIFIED](/demo/p2p/p2p-cny-wechat-12-payment-verified-fr.png)

---

## 8. Libération — les fonds bougent

La libération déplace les jetons sous séquestre : le vendeur (pré-signature ou
co-signature) et le moteur signent chacun une dépense de la sortie de séquestre,
et deux signatures satisfont le script 2-sur-3. Les jetons arrivent à l'adresse
de réception de l'acheteur :

![ESCROW_RELEASED](/demo/p2p/p2p-cny-wechat-13-escrow-released-fr.png)

Comme le vendeur a été payé directement, il n'y a pas d'étape de versement fiat —
l'échange se termine :

![COMPLETED](/demo/p2p/p2p-cny-wechat-14-completed-fr.png)

---

## Ce qui vous protège

| Risque | Mesure |
|---|---|
| La contrepartie se retire | Les fonds sont dans une adresse P2SH 2-sur-3 ; personne ne peut les bouger seul |
| Sous- ou surpaiement | Le montant est fixé à l'appariement ; les instructions portent le chiffre exact et un motif par échange |
| Fausse déclaration de paiement | La déclaration de l'acheteur seule ne libère jamais — le vendeur confirme sur son propre relevé |
| Le vendeur déclare ne pas avoir reçu | Arbitrage ; l'enregistrement de chaîne et le magasin de preuves constituent les éléments de preuve |
| Moteur malveillant | Les étapes réservées au moteur exigent la signature DID du moteur ; chaque transition est ancrée et publiquement auditable |
| Litige | L'une ou l'autre partie gèle l'échange ; les jetons restent verrouillés jusqu'à résolution |
| Remboursement | `expire` → `refund`, co-signés par le moteur et le vendeur — sans accord de l'acheteur, sans timelock |

---

## Passer en production

La démo tourne contre le service de règlement du dépôt avec un stockage en
mémoire et sans contrôle de chaîne. Le flux réel relie le signataire de séquestre
à l'étape de diffusion L0 et fait tourner le moteur contre L1-SOCIAL pour le
carnet d'ordres et l'ancrage d'audit ; l'acheteur paie le vendeur directement, et
le moteur ne fait toujours que co-signer.
