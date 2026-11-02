# Règlement FIAT (monnaie fiduciaire) — échanger des BIG avec WeChat / Alipay / virement bancaire ou PayPal

**Terminologie.** FIAT = monnaie fiduciaire ; CNY = yuan ; USD = dollar américain ; P2P = pair à pair.

**De quoi s'agit-il.** Dans le portefeuille Bigtangle, échangez des **BIG** directement contre de la monnaie fiduciaire (WeChat Pay / Alipay / virement bancaire, ou **PayPal USD**). Les BIG du vendeur sont d'abord placés dans une **adresse de séquestre** qui ne peut être utilisée qu'avec l'accord de deux parties sur trois — vendeur, acheteur et plateforme ; l'acheteur paie l'argent directement au vendeur ; le vendeur confirme sur son propre relevé, puis libère les BIG. La plateforme ne conserve pas vos fonds et ne touche jamais à la monnaie fiduciaire.

**À propos des captures d'écran.** Les captures ci-dessous proviennent d'un environnement de démonstration sur appareil réel ; les montants et les empreintes affichés sont des données de démonstration et n'impliquent aucun fonds réel.

Ce guide présente : un vendeur publie une annonce de vente de BIG, un acheteur achète, le séquestre se verrouille, l'acheteur paie, le vendeur confirme, les BIG sont libérés, ainsi que le remboursement en cas d'expiration. Taux **BIG/CNY = 0.01**, annonce **10,000 BIG → 100 CNY**.

## Aperçu du déroulement

```
En attente de jumelage → Jumelé → Séquestre verrouillé → Paiement en attente → Paiement déclaré → Paiement confirmé → Séquestre libéré → Terminé
```

Chaque étape s'affiche sur la carte de transaction dans l'application ; l'état ne peut qu'avancer, sans saut ni retour en arrière.

Parcours facultatif : après le paiement, si les deux parties ne sont pas d'accord, la transaction peut être gelée et un litige soumis ; la plateforme aide alors à trancher (libération des fonds à l'acheteur ou remboursement au vendeur).


**PayPal (dollars).** En choisissant **PayPal**, la monnaie fiduciaire passe automatiquement en **USD**, le compte de réception devient une adresse e-mail PayPal, et le reste du déroulement est identique. Démonstration complète : [p2p-paypal.zh.md](p2p-paypal.zh.md) → `assets/p2p-paypal.zh.mobile.pdf` (**10,000 BIG → 100 USD**).



---

## 1. Le vendeur enregistre son profil de réception

Le vendeur ouvre **P2P → Mes transactions**, choisit le mode de réception (WeChat, Alipay, banque ou PayPal) et saisit le nom du titulaire et le numéro de compte (une adresse e-mail pour PayPal). Ces informations ne sont montrées à l'acheteur qu'une fois la transaction conclue ; elles n'apparaissent jamais dans le carnet d'ordres public.

![Le vendeur enregistre son profil WeChat Pay](assets/screenshots/p2p-cny-wechat-01-profile-fr.png)

---

## 2. Le vendeur publie une annonce de vente de BIG

Dans **Publier une annonce de vente**, le vendeur indique le jeton (`bc`), la quantité **10,000**, le prix **0.01**, la monnaie fiduciaire **CNY**, le mode de réception **WeChat**, puis publie.

Une fois publiée, l'annonce apparaît dans le carnet d'ordres public avec l'état **En attente de jumelage**. Le vendeur peut à tout moment retirer une annonce qui n'a pas encore trouvé preneur.

![Annonce de vente en wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-fr.png)

---

## 3. L'acheteur apparie l'annonce

L'acheteur ouvre l'annonce, saisit l'adresse qui recevra les BIG, puis confirme l'achat. Il n'a pas encore besoin d'indiquer un compte WeChat ou Alipay : les informations de réception du vendeur ne sont communiquées qu'à cet acheteur, après le verrouillage du séquestre.

L'application attribue à cette transaction un numéro unique et prépare l'adresse de séquestre ; l'état passe à **Jumelé**.

![L'acheteur saisit l'adresse de réception](assets/screenshots/p2p-cny-wechat-03-match-fr.png)

![Échange créé à l'état Jumelé](assets/screenshots/p2p-cny-wechat-04-matched-fr.png)

---

## 4. Le vendeur verrouille ses BIG dans le séquestre

L'application génère pour cette transaction une **adresse de séquestre 2-sur-3** : les fonds ne peuvent être utilisés qu'avec l'accord de deux parties parmi les trois (vendeur, acheteur, plateforme), et aucune partie ne peut les retirer seule.

Le vendeur transfère **10,000 BIG** à cette adresse, puis colle dans l'application l'empreinte de ce transfert. Après vérification du montant et de l'adresse de réception, l'état passe à **Séquestre verrouillé**. L'acheteur voit ainsi que les BIG sont bien bloqués avant même de payer en monnaie fiduciaire.

![Le vendeur colle l'empreinte de la transaction de séquestre](assets/screenshots/p2p-cny-wechat-05-escrow-lock-fr.png)

![Séquestre verrouillé](assets/screenshots/p2p-cny-wechat-06-escrow-locked-fr.png)

---

## 5. L'acheteur consulte les instructions de paiement

En appuyant sur **Détails du paiement**, l'acheteur voit :

- le nom du titulaire
- le compte de réception (numéro WeChat / Alipay / bancaire, ou adresse e-mail PayPal)
- le montant exact **100 CNY**
- un **code de référence** propre à cette transaction
- la date limite de paiement

L'acheteur doit inscrire le code de référence dans le libellé de son virement. L'état passe à **Paiement en attente** ; si le paiement n'est pas effectué avant la date limite, la transaction expire et les fonds sont remboursés.

![Instructions de paiement : titulaire, compte, 100 CNY, référence](assets/screenshots/p2p-cny-wechat-08-instructions-fr.png)

---

## 6. L'acheteur paie en CNY et déclare son paiement

L'acheteur effectue un virement de **100 CNY** depuis son propre WeChat, inscrit le code de référence dans le libellé, puis colle le numéro de transaction (numéro de référence du virement) dans **Numéro de transaction** et appuie sur **J'ai payé**.

Il peut joindre une image de son justificatif de paiement ; cette image est conservée uniquement côté serveur et n'est jamais inscrite sur la chaîne.

![Numéro de transaction saisi](assets/screenshots/p2p-cny-wechat-09-payment-pending-fr.png)

L'état passe à **Paiement déclaré**. À ce stade, les BIG restent verrouillés : il ne s'agit que de la déclaration de paiement de l'acheteur.

![Paiement déclaré](assets/screenshots/p2p-cny-wechat-10-payment-claimed-fr.png)

---

## 7. Le vendeur confirme sur son propre relevé

La carte de transaction du vendeur affiche le numéro de référence et le libellé saisis par l'acheteur. Le vendeur vérifie **le montant + le libellé + l'heure + le numéro de transaction uniquement dans son propre relevé WeChat**, et n'appuie sur **Confirmer la réception** qu'après vérification.

Une capture d'écran ne fait pas foi ; seul le crédit réellement reçu sur votre propre compte compte.

![Le vendeur voit le numéro de transaction + l'avertissement de confirmation](assets/screenshots/p2p-cny-wechat-11-seller-confirm-fr.png)

L'état passe à **Paiement confirmé**.

![Paiement confirmé](assets/screenshots/p2p-cny-wechat-12-payment-verified-fr.png)

---

## 8. Le vendeur libère le séquestre

> **Vendeurs, libérez le séquestre sans attendre.** Dès la confirmation du paiement, appuyez sur **Libérer les fonds**. Une libération tardive dégrade la réputation du vendeur ; des retards graves ou répétés le font marquer comme **non fiable**, ce qui pénalise ses commandes futures.

Dès que le vendeur a confirmé le paiement, il appuie sur **Libérer les fonds** ; la plateforme cosigne alors et les BIG sont transférés à l'adresse de réception de l'acheteur. La signature du vendeur et celle de la plateforme suffisent pour libérer les fonds, et aucune des parties ne peut y toucher seule.

Comme le vendeur est payé directement, il n'y a aucune étape supplémentaire de versement en monnaie fiduciaire : la transaction se termine aussitôt.

![Séquestre libéré](assets/screenshots/p2p-cny-wechat-13-escrow-released-fr.png)

![Terminé](assets/screenshots/p2p-cny-wechat-14-completed-fr.png)

L'état passe à **Terminé**.

---

## 9. Facultatif : un litige tranché avec l'aide de la plateforme

Si les deux parties ne sont pas d'accord sur le paiement (montant incorrect, paiement non reçu, vendeur qui tarde à libérer, etc.), chacune peut geler la transaction et soumettre un litige. Après vérification du séquestre et des preuves de paiement, la plateforme décide de **libérer les fonds à l'acheteur** ou de **rembourser le vendeur**.

Les litiges perdus par le vendeur et ses retards répétés sont enregistrés dans sa réputation ; en cas de manquement grave, il est marqué comme **non fiable**.

---

## 10. Expiration ou échec → remboursement

Si l'acheteur ne paie jamais, le vendeur peut laisser la transaction expirer ; les BIG placés en séquestre lui sont rendus, sans avoir besoin de l'accord de l'acheteur.

Aucune des parties ne détient jamais les fonds de l'autre.

---

## 11. Facultatif : « Vérifier avec mon téléphone » (acheteur, libération tardive)

Cette étape n'est pas nécessaire pour un règlement normal. L'acheteur ne voit **« Vérifier avec mon téléphone »** que si le vendeur tarde à libérer (plus de **30 minutes** après la déclaration de paiement de l'acheteur, ou paiement confirmé mais toujours pas de libération) **ou** si un litige est ouvert.

Cette option n'apparaît que pour **Alipay / virement bancaire**, car l'acheteur peut y consulter l'historique des virements ; WeChat n'envoie qu'une notification au bénéficiaire et PayPal n'offre aucun accès en lecture, donc elle n'y est pas proposée. L'acheteur effectue une seule lecture avec son téléphone appairé ; le portefeuille signe le résultat et le transmet. Cette vérification est enregistrée dans la réputation du vendeur, mais ne remplace pas la libération que le vendeur doit effectuer sans attendre.

---

## Comparaison : Binance P2P et ce règlement

| Fonctionnalité | Binance P2P | Ce règlement |
|---|---|---|
| Vérification de la monnaie fiduciaire | Le vendeur clique sur « Confirmer » (système de réputation) | Le vendeur confirme sur son propre relevé ; la plateforme libère les fonds selon le protocole |
| Dépôt fiduciaire | La plateforme (acheteur → vendeur) | L'acheteur paie directement le vendeur ; la plateforme ne touche jamais la monnaie fiduciaire |
| Séquestre | Registre interne à la plateforme | Séquestre 2-sur-3 sur la chaîne, vérifiable publiquement |
| Remboursement | Ticket auprès du support | Expiration automatique, retour au vendeur |
| Résolution des litiges | Support humain (plusieurs jours) | Litige dans l'application + arbitrage de la plateforme (plus rapide) |

---

## Chronologie

```
Jumelé                 14:20  Montant fixé au jumelage
Séquestre verrouillé   14:23  Le vendeur transfère les BIG, l'application confirme la réception
Paiement en attente    14:24  L'acheteur voit les instructions de paiement
Paiement déclaré       14:25  L'acheteur paie et renseigne le numéro de transaction
Paiement confirmé      14:26  Le vendeur confirme sur son propre relevé
Séquestre libéré       14:27  Vendeur et plateforme cosignent, les BIG vont à l'acheteur
Terminé                14:27  Transaction terminée
```

---

Pour comprendre les détails d'implémentation — machine à états, signatures, script de séquestre et interfaces —, consultez la documentation développeur `docs/p2p.md`.
