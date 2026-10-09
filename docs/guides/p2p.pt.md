# Liquidação P2P — troca entre trilhos nativa da carteira

**O que é.** Uma troca ponto a ponto entre cripto na **Bigtangle L0** e moeda
fiduciária via **PayPal** (ou os trilhos CNY — WeChat Pay / Alipay / banco). O
vendedor deposita os tokens em um **endereço P2SH 2-de-3** (vendedor, comprador,
motor); o comprador paga uma obrigação fiduciária de **valor exato**; o motor
prova o pagamento e libera o depósito. Cada passo irreversível é assinado com a
chave PQ da própria carteira, e o motor só pode **coassinar** um gasto — ele
nunca guarda o seu dinheiro.

**Onde.** A tela **P2P** da carteira (barra lateral → Trade → P2P). Tudo abaixo
foi capturado dessa tela na compilação de demonstração local.

**Demonstração vs. produção.** As capturas vêm da demonstração: o motor roda em
modo PayPal simulado (URLs de fatura falsas e hashes de transação sintéticos) e
os passos lock/verify/release são assinados por uma chave de motor local. A
máquina de estados, as assinaturas, o log de eventos somente-anexação e a âncora
de auditoria on-chain são reais; apenas as chamadas externas ao PayPal e a
difusão na L0 são simuladas.

**Sem “Confirmar” manual.** No trilho PayPal não há botão de “Confirmar” do
vendedor — o motor verifica o pagamento a partir da própria evidência. (Os
trilhos CNY, que não têm webhook, usam em vez disso uma confirmação explícita do
vendedor; veja `docs/p2pcny.md`.)

---

## O fluxo em resumo

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Passo | Quem age | On-chain / motor |
|---|---|---|---|
| 1 | O vendedor publica uma ordem de venda assinada | vendedor | ordem guardada, sem financiamento |
| 2 | O comprador dá match (endereço de recebimento + conta PayPal) | comprador | `swapId` criado, endereço de depósito derivado |
| 3 | O vendedor financia o depósito 2-de-3, o motor prova o bloqueio | vendedor + motor | `ESCROW_LOCKED` na L0 |
| 4 | O comprador paga a fatura de valor exato e a informa | comprador | `PAYMENT_PENDING` |
| 5 | O motor verifica o pagamento por si mesmo | motor | `PAYMENT_VERIFIED` |
| 6 | Motor + comprador coassinam a liberação, os tokens se movem | motor + comprador | `ESCROW_RELEASED` |
| 7 | O motor paga o vendedor via PayPal Payouts | motor | `COMPLETED` |

Cada transição é ancorada como um registro `social.p2p-swap` na cadeia
L1-SOCIAL, de modo que todo o ciclo de vida é auditável publicamente sem expor
os dados de PayPal de nenhuma das partes.

---

## 1. O vendedor publica uma ordem de venda

Na aba **Open sells**, preencha a ordem: o token e a quantidade que você entrega,
o preço fiduciário desejado, a moeda, a cadeia do token e o **método de
pagamento** (PayPal ou um trilho CNY). Os termos são fixados na ordem ao
publicá-la, então isso é assinado com a chave da sua carteira.

![O formulário da ordem de venda, trilho PayPal selecionado](/demo/p2p/p2p-01-order-pt.png)

Depois de publicada, a ordem fica `ACTIVE` no motor e aparece no livro de ofertas
público (sem dados pessoais):

![A ordem está viva no livro](/demo/p2p/p2p-02-active-pt.png)

---

## 2. O comprador dá match

O comprador abre a ordem e fornece o **endereço de recebimento** dos tokens
liberados e a **conta PayPal** que será faturada (e um e-mail para a fatura). O
match compromete o comprador a pagar, então também é assinado:

![O comprador preenche o endereço de recebimento e a conta PayPal](/demo/p2p/p2p-03-match-pt.png)

O motor cria um `swapId` único para o ciclo de vida e a troca vai para `MATCHED`,
visível na aba **My swaps** do comprador:

![A troca está MATCHED](/demo/p2p/p2p-04-matched-pt.png)

---

## 3. Bloqueio do depósito — o vendedor financia a L0

O vendedor envia os tokens ao endereço de depósito determinístico 2-de-3 e
informa o `txHash` da transferência. O motor prova o bloqueio a partir da cadeia
(`CONFIRMED`, destino `escrowAddress`, valor) e falha fechado se qualquer
verificação não se mantiver. A troca agora é `ESCROW_LOCKED`:

![O vendedor bloqueia o depósito](/demo/p2p/p2p-05-escrow-locked-pt.png)

O comprador vê os fundos garantidos **antes** de enviar qualquer fiat, e ganha
uma ação **I have paid** (Eu paguei) assim que o bloqueio é provado:

![O comprador vê o depósito bloqueado](/demo/p2p/p2p-06-buyer-locked-pt.png)

---

## 4. O comprador paga

O comprador paga a fatura hospedada do PayPal (o PayPal guarda o dinheiro — o
motor nunca) e informa o pagamento. Isto é apenas uma *dica*; a verificação real
é a evidência do próprio motor. A troca fica `PAYMENT_PENDING`, e um cronômetro
de timeout começa — se a fatura nunca for paga, o vendedor pode expirar e
devolver o depósito sem o consentimento do comprador:

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-pt.png)

---

## 5. O motor verifica o pagamento

Nenhuma confirmação do vendedor está envolvida. O motor confere o pagamento a
partir da própria fonte e avança a troca para `PAYMENT_VERIFIED` — o depósito
está pronto para ser liberado ao endereço de recebimento do comprador:

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-pt.png)

---

## 6. Liberação — os fundos se movem

A liberação move os tokens depositados: o motor e o comprador assinam cada um um
gasto da saída do depósito, e duas assinaturas satisfazem o script 2-de-3. Os
tokens chegam ao endereço de recebimento do comprador e a troca fica
`ESCROW_RELEASED`:

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-pt.png)

---

## 7. Pagamento — o vendedor recebe o fiat

O último passo paga o vendedor via PayPal Payouts, e a troca alcança `COMPLETED`:

![COMPLETED](/demo/p2p/p2p-10-completed-pt.png)

O resultado do pagamento (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) chega por
webhook do PayPal ou é consultado como reserva; uma falha pode ser repetida a
partir de `COMPLETED` sem refazer a troca.

---

## O que protege você

| Risco | Mitigação |
|---|---|
| A contraparte desiste | Os fundos ficam num endereço P2SH 2-de-3; ninguém os move sozinho |
| Pagamento a menos ou a mais | A fatura é de valor exato: ou é paga integralmente, ou fica em aberto |
| Alegação de pagamento falsa | O motor verifica o pagamento por si mesmo — o pagador não pode autoatribuí-lo |
| Motor malicioso | Passos exclusivos do motor exigem a assinatura DID do motor; cada transição é ancorada e auditável publicamente |
| Estorno após a liberação | `PAYMENT.CAPTURE.REVERSED` ativa um congelamento: passos à frente param, estorno/expiração continuam possíveis |
| Disputa | `CUSTOMER.DISPUTE.*` pausa a troca até resolver |
| Falha de pagamento | `HELD`/`FAILED`/`BLOCKED` são estados de primeira classe; repita com a mesma referência de pagamento |

---

## Ir para produção

A demonstração roda contra o serviço de liquidação do repositório com PayPal
simulado. Para o fluxo real você precisa de uma conta business do PayPal com
Payouts ativados, suas credenciais de API e webhook id, e o assinante do depósito
ligado ao passo de difusão na L0. Até então o motor executa a mesma máquina de
estados sem tocar dinheiro real.
