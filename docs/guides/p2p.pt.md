# Liquidação P2P — troca CNY nativa da carteira

**O que é.** Uma troca ponto a ponto entre cripto na **Bigtangle L0** e fiat CNY
(WeChat Pay / Alipay / banco). O vendedor deposita os tokens em um **endereço
P2SH 2-de-3** (vendedor, comprador, motor); o comprador paga o vendedor
**diretamente** no próprio aplicativo de pagamento; o vendedor confirma o
recebimento no próprio extrato e o depósito é liberado. Cada passo irreversível
é assinado com a chave PQ da própria carteira, e o motor só pode **coassinar** um
gasto — ele nunca guarda os seus fundos e nunca toca no fiat.

**Onde.** A tela **P2P** da carteira (barra lateral → Trade → P2P). Tudo abaixo
foi capturado dessa tela na compilação de demonstração local.

**Demonstração vs. produção.** As capturas vêm da demonstração: o motor roda com
um armazenamento em memória e sem verificação de cadeia, então as etapas
lock/release usam hashes de transação sintéticos. A máquina de estados, as
assinaturas, o log de eventos somente-anexação e a âncora de auditoria on-chain
são reais; apenas a difusão na L0 é simulada.

**A confirmação do vendedor é o sinal do fiat.** Não há API de cobrança para uma
conta pessoal de WeChat/Alipay/banco, então não há evento de pagamento
verificável por máquina para aguardar. O vendedor confere **valor + descrição +
hora + número da transação no próprio aplicativo** — uma captura de tela nunca conta — e
confirma. Os detalhes de projeto estão em `docs/p2p.md`.

---

## O fluxo em resumo

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──instructions──▶ PAYMENT_PENDING
                                                                          │
   PAYMENT_PENDING ──proof──▶ PAYMENT_CLAIMED ──confirm──▶ PAYMENT_VERIFIED
                                                                  │
                            PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──complete──▶ COMPLETED
```

| # | Passo | Quem age | On-chain / motor |
|---|---|---|---|
| 1 | O vendedor guarda um perfil de cobrança CNY | vendedor | perfil guardado no servidor, nunca no livro |
| 2 | O vendedor publica uma ordem de venda assinada | vendedor | ordem guardada, sem financiamento |
| 3 | O comprador dá match (endereço de recebimento) | comprador | `swapId` criado, endereço de depósito derivado |
| 4 | O vendedor financia o depósito 2-de-3, o motor prova o bloqueio | vendedor + motor | `ESCROW_LOCKED` na L0 |
| 5 | O comprador obtém as instruções de pagamento | comprador | `PAYMENT_PENDING` (+ descrição por troca) |
| 6 | O comprador paga no próprio aplicativo e reivindica com o número da transação | comprador | `PAYMENT_CLAIMED` |
| 7 | O vendedor confere o próprio extrato e confirma | vendedor | `PAYMENT_VERIFIED` |
| 8 | O motor libera os tokens, a troca se conclui | motor | `ESCROW_RELEASED` → `COMPLETED` |

Cada transição é ancorada como um registro `social.p2p-swap` na cadeia
L1-SOCIAL, de modo que todo o ciclo de vida é auditável publicamente sem expor
os dados de conta de qualquer das partes.

---

## 1. O vendedor guarda um perfil de cobrança

Na aba **My swaps**, o vendedor escolhe um trilho (WeChat, Alipay ou banco) e
informa o nome do beneficiário e a conta. O perfil é guardado no servidor sob o DID do
vendedor e **não** faz parte do livro de ofertas público — ele é revelado apenas
ao comprador emparelhado pela chamada de instruções.

![O vendedor guarda o perfil de pagamento do WeChat](/demo/p2p/p2p-cny-wechat-01-profile-pt.png)

---

## 2. O vendedor publica uma ordem de venda

Na aba **Open sells**, preencha a ordem: o token e a quantidade que você entrega,
o preço em CNY desejado, a cadeia em que os tokens estão e o **método de
pagamento** (wechat / alipay / bank). Selecionar um trilho CNY muda a moeda para
CNY. Os termos são fixados na ordem ao publicá-la, então isso é assinado com a
chave da sua carteira:

![O formulário da ordem de venda com o trilho wechat](/demo/p2p/p2p-cny-wechat-02-order-pt.png)

Depois de publicada, a ordem fica `ACTIVE` no motor e aparece no livro de
ofertas público (sem dados pessoais).

---

## 3. O comprador dá match

O comprador abre a ordem e fornece o **endereço de recebimento** dos tokens
liberados. O match compromete o comprador a pagar, então também é assinado:

![O comprador preenche o endereço de recebimento](/demo/p2p/p2p-cny-wechat-03-match-pt.png)

O motor cria um `swapId` único para o ciclo de vida e a troca vai para `MATCHED`,
visível na aba **My swaps** do comprador:

![A troca está MATCHED](/demo/p2p/p2p-cny-wechat-04-matched-pt.png)

---

## 4. Bloqueio do depósito — o vendedor financia a L0

O vendedor envia os tokens ao endereço de depósito determinístico 2-de-3 e
informa o `txHash` da transferência. O motor prova o bloqueio a partir da cadeia
(`CONFIRMED`, destino `escrowAddress`, valor) e falha fechado se qualquer
verificação não se mantiver:

![O vendedor cola o hash da transação do depósito](/demo/p2p/p2p-cny-wechat-05-escrow-lock-pt.png)

A troca agora é `ESCROW_LOCKED`. O comprador vê os fundos garantidos **antes** de
enviar qualquer fiat, e ganha uma ação **Payment details** (Detalhes do
pagamento):

![ESCROW_LOCKED](/demo/p2p/p2p-cny-wechat-06-escrow-locked-pt.png)

---

## 5. O comprador obtém as instruções de pagamento

O comprador pressiona **Payment details** (Detalhes do pagamento); o motor revela
o perfil do vendedor e emite um **código de descrição por troca** que a
transferência *deve* levar, além do valor exato e de um prazo. As instruções
aparecem em linha no cartão da troca:

![Instruções de pagamento: titular, conta, 715 CNY, descrição](/demo/p2p/p2p-cny-wechat-08-instructions-pt.png)

A troca fica `PAYMENT_PENDING`, e um cronômetro de timeout começa — se o
comprador nunca pagar, o vendedor pode expirar e devolver o depósito sem o
consentimento do comprador.

---

## 6. O comprador paga e reivindica com o número da transação

O comprador transfere o valor exato no próprio aplicativo WeChat/Alipay/banco,
cola o número da transação em **Transaction ID** e pressiona **I have
paid** (Eu paguei). Uma imagem de recibo opcional é guardada no servidor; apenas
o seu `sha256` é ancorado no evento da troca:

![Transaction ID (número da transação) informado](/demo/p2p/p2p-cny-wechat-09-payment-pending-pt.png)

O status agora é `PAYMENT_CLAIMED` — **os tokens continuam bloqueados.** Este
estado existe puramente como a reivindicação do comprador:

![PAYMENT_CLAIMED](/demo/p2p/p2p-cny-wechat-10-payment-claimed-pt.png)

---

## 7. O vendedor confirma no próprio extrato

O cartão do vendedor mostra o número da transação do comprador e a descrição. O vendedor
confere **valor + descrição + hora + número da transação na própria conta** e só então
pressiona **Confirm received** (Confirmar recebimento):

![O vendedor vê o número da transação e o aviso de confirmação](/demo/p2p/p2p-cny-wechat-11-seller-confirm-pt.png)

A troca fica `PAYMENT_VERIFIED`:

![PAYMENT_VERIFIED](/demo/p2p/p2p-cny-wechat-12-payment-verified-pt.png)

---

## 8. Liberação — os fundos se movem

A liberação move os tokens depositados: o vendedor (pré-assinatura ou
coassinatura) e o motor assinam cada um um gasto da saída do depósito, e duas
assinaturas satisfazem o script 2-de-3. Os tokens chegam ao endereço de
recebimento do comprador:

![ESCROW_RELEASED](/demo/p2p/p2p-cny-wechat-13-escrow-released-pt.png)

Como o vendedor foi pago diretamente, não há etapa de pagamento fiat — a troca se
conclui:

![COMPLETED](/demo/p2p/p2p-cny-wechat-14-completed-pt.png)

---

## Opcional — confirmação automática a partir do seu próprio telefone

O passo 7 é normalmente um toque manual. Para o motor confirmar por você,
emparelhe o telefone uma vez e deixe-o ler o recibo **do vendedor** — o mesmo
extrato que o vendedor conferiria à mão, lido automaticamente.

**Emparelhar o telefone (uma vez).** Instale o app **Mobile Agent**
([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp))
no seu próprio telefone; ele executa um servidor MCP *no telefone* (serviço de
acessibilidade, sem adb). Conceda acessibilidade, inicie o servidor e anote o
endpoint e o **código curto de uso único** exibido. No wallet, abra
**Dispositivo**, pressione **Emparelhar com código** e informe o endpoint e o
código. Revogue o emparelhamento a qualquer momento em **Configurações › Acesso
› Dispositivos emparelhados**.

**Verificar uma troca.** No cartão da troca, pressione **Verificar com meu
telefone** — qualquer das partes pode verificar o próprio dispositivo. O motor
conecta ao endpoint emparelhado e lê o lançamento correspondente no seu próprio
app de pagamento (valor, descrição, hora e número da transação); em seguida a
**wallet assina o veredicto**. Alipay e os bancos expõem a tela à
acessibilidade; o WeChat oculta a interface, então para o WeChat o app lê a
notificação «pagamento recebido» do WeChat:

![A notificação de pagamento do WeChat do destinatário](/demo/p2p/p2p-verify-wechat-notification-en.png)

**Antes de verificar.**

- **O motor precisa alcançar seu telefone.** Ele se conecta diretamente ao endpoint emparelhado, então este deve ser um endereço HTTPS público (por exemplo, um túnel até o telefone). Um endereço de rede doméstica como `http://192.168.x.x` não é alcançável e é recusado.
- **Alipay e banco: abra o lançamento primeiro.** A leitura captura o que está na tela, então abra o detalhe da transação deste pagamento no aplicativo antes de tocar em **Read my phone**.
- **WeChat: só o vendedor.** Apenas o telefone do destinatário recebe a notificação de “pagamento recebido” do WeChat, então um pagamento por WeChat pode ser verificado pelo vendedor, não pelo comprador.

**O que muda.** Por padrão, uma leitura é apenas prova em disputa. Sob a política
`SETTLEMENT_CNY_AUTO_RELEASE_ON` (`seller_receipt`, ou as mais estritas
`two_sided` / `verified_receipt`) uma leitura qualificada **substitui a
confirmação manual** e libera o depósito. Continua sendo atestação, não um
oráculo: o emparelhamento é o consentimento, é revogável a qualquer momento, e o
motor lê apenas o lado que você emparelhou.

---

## O que protege você

| Risco | Mitigação |
|---|---|
| A contraparte desiste | Os fundos ficam num endereço P2SH 2-de-3; ninguém os move sozinho |
| Pagamento a menos ou a mais | O valor é fixado no match; as instruções levam o número exato e uma descrição por troca |
| Alegação de pagamento falsa | A reivindicação do comprador sozinha nunca libera — o vendedor confirma no próprio extrato |
| O vendedor alega não recebimento | Arbitragem; o registro da cadeia e o armazenamento de provas são a evidência |
| Motor malicioso | Passos exclusivos do motor exigem a assinatura DID do motor; cada transição é ancorada e auditável publicamente |
| Disputa | Qualquer das partes congela a troca; os tokens ficam bloqueados até resolver |
| Reembolso | `expire` → `refund`, coassinados pelo motor e pelo vendedor — sem consentimento do comprador, sem timelock |

---

## Ir para produção

A demonstração roda contra o serviço de liquidação do repositório com
armazenamento em memória e sem verificação de cadeia. O fluxo real liga o
assinante do depósito ao passo de difusão na L0 e roda o motor contra a
L1-SOCIAL para o livro de ofertas e a âncora de auditoria; o comprador paga o
vendedor diretamente, e o motor continua apenas coassinando.
