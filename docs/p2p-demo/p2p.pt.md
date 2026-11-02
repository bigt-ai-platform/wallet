# FIAT (moeda fiduciária) — troque BIG via WeChat, Alipay, banco ou PayPal

**Termos.** FIAT = moeda fiduciária; CNY = yuan chinês; USD = dólar americano; P2P = ponto a ponto.

**O que é isto.** Na carteira Bigtangle, você troca **BIG** diretamente por moeda fiduciária (WeChat Pay, Alipay, banco ou **PayPal USD**). O BIG do vendedor primeiro vai para um **endereço de custódia** que só pode ser movimentado com o acordo de duas das três partes: comprador, vendedor e plataforma. O comprador paga o vendedor diretamente; o vendedor confere o próprio extrato e então libera o BIG. A plataforma não guarda o seu dinheiro nem intermedeia a moeda fiduciária.

**Sobre as capturas de tela.** As imagens abaixo vêm de um ambiente de demonstração em aparelho real; valores e hashes são dados de demonstração e não envolvem dinheiro real.

Este guia mostra: o vendedor publica uma oferta de venda de BIG, o comprador compra, a custódia é bloqueada, o comprador paga, o vendedor confirma, o BIG é liberado e, se houver expiração, o reembolso acontece. A taxa é **BIG/CNY = 0,01** e a oferta é de **10.000 BIG → 100 CNY**.

## Visão geral do fluxo

```
Aguardando correspondência → Correspondido → Custódia bloqueada → Aguardando pagamento → Pagamento informado → Pagamento confirmado → Custódia liberada → Concluído
```

Cada etapa aparece no cartão de negociação do aplicativo; o status só avança, nunca salta nem volta.

Caminho opcional: depois do pagamento, se as duas partes discordarem, qualquer uma delas pode congelar a negociação e abrir uma disputa, e a plataforma ajuda a decidir (liberar o BIG para o comprador ou devolver o dinheiro ao vendedor).


**PayPal (dólar).** Ao escolher **PayPal**, a moeda fiduciária passa automaticamente para **USD** e a conta de recebimento passa a ser o e-mail do PayPal; o restante do fluxo é idêntico. A demonstração completa está em [p2p-paypal.zh.md](p2p-paypal.zh.md) → `assets/p2p-paypal.zh.mobile.pdf` (**10.000 BIG → 100 USD**).

---

## 1. O vendedor salva os dados de recebimento

O vendedor abre **P2P → Minhas negociações**, escolhe a forma de recebimento (WeChat, Alipay, banco ou PayPal) e preenche o nome do titular e o número da conta (no PayPal, o e-mail). Esses dados só são mostrados ao comprador depois que a negociação é fechada e nunca aparecem no livro de ofertas público.

![Vendedor salva o perfil do WeChat Pay](assets/screenshots/p2p-cny-wechat-01-profile-pt.png)

---

## 2. O vendedor publica a oferta de venda de BIG

Em **Publicar oferta de venda**, o vendedor informa o token (`bc`), a quantidade **10.000**, o preço **0,01**, a moeda fiduciária **CNY** e a forma de recebimento **WeChat**, e publica.

Depois de publicada, a oferta aparece no livro de ofertas público com o status **Aguardando correspondência**. O vendedor pode cancelar a qualquer momento uma oferta que ainda não tenha sido aceita.

![Oferta de venda publicada em wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-pt.png)

---

## 3. O comprador encontra a oferta

O comprador abre a oferta de venda, informa o endereço que vai receber o BIG e confirma a compra. Nesse momento ainda não é preciso informar conta de WeChat ou Alipay: os dados de recebimento do vendedor são mostrados somente a esse comprador, depois do bloqueio da custódia.

O aplicativo cria um número de negociação único para o negócio e prepara o endereço de custódia; o status passa a **Correspondido**.

![Comprador informa o endereço de recebimento](assets/screenshots/p2p-cny-wechat-03-match-pt.png)

![Troca criada como correspondida](assets/screenshots/p2p-cny-wechat-04-matched-pt.png)

---

## 4. O vendedor bloqueia o BIG na custódia

O aplicativo gera um **endereço de custódia 2 de 3**: o dinheiro só pode ser movimentado com o acordo de duas das três partes (vendedor, comprador e plataforma), e nenhuma delas consegue retirá-lo sozinha.

O vendedor transfere **10.000 BIG** para esse endereço e cola no aplicativo o hash dessa transferência. Depois de conferir o valor e o endereço de destino, o status passa a **Custódia bloqueada**. O comprador já consegue ver que o BIG está bloqueado antes de pagar a moeda fiduciária.

![Vendedor cola o hash da transação de custódia](assets/screenshots/p2p-cny-wechat-05-escrow-lock-pt.png)

![Custódia bloqueada](assets/screenshots/p2p-cny-wechat-06-escrow-locked-pt.png)

---

## 5. O comprador abre as instruções de pagamento

Ao tocar em **Detalhes do pagamento**, o comprador vê:

- o nome do titular da conta do vendedor
- a conta de recebimento (WeChat, Alipay, conta bancária ou e-mail do PayPal)
- o valor exato de **100 CNY**
- o **código de referência** exclusivo desta negociação
- o prazo para pagar

Na transferência, o comprador precisa colocar o código de referência no campo de observação. O status passa a **Aguardando pagamento**; se o prazo terminar sem pagamento, a negociação expira e o BIG é devolvido.

![Instruções de pagamento: titular, conta, 100 CNY e referência](assets/screenshots/p2p-cny-wechat-08-instructions-pt.png)

---

## 6. O comprador paga em CNY e informa o pagamento

O comprador transfere **100 CNY** pelo próprio WeChat, coloca o código de referência na observação, cola o número da transação (número de série) em **Número da transação** e toca em **Já paguei**.

É possível anexar uma imagem do comprovante de pagamento; a imagem fica guardada apenas no servidor e não é gravada na blockchain.

![Número da transação (número de série) informado](assets/screenshots/p2p-cny-wechat-09-payment-pending-pt.png)

O status passa a **Pagamento informado**. Nesse momento o BIG continua bloqueado: trata-se apenas da declaração de pagamento do comprador.

![Pagamento informado](assets/screenshots/p2p-cny-wechat-10-payment-claimed-pt.png)

---

## 7. O vendedor confere no próprio extrato

O cartão de negociação do vendedor mostra o número de série e a observação informados pelo comprador. O vendedor confere **valor + observação + horário + número de série** somente no próprio extrato do WeChat e só toca em **Confirmar recebimento** quando tudo estiver correto.

Capturas de tela não servem como comprovante; vale o valor que realmente entrou na sua conta.

![Vendedor vê o número de série e o aviso de confirmação](assets/screenshots/p2p-cny-wechat-11-seller-confirm-pt.png)

O status passa a **Pagamento confirmado**.

![Pagamento confirmado](assets/screenshots/p2p-cny-wechat-12-payment-verified-pt.png)

---

## 8. O vendedor libera a custódia

> **Vendedor, libere a custódia o quanto antes.** Depois de confirmar o recebimento, toque imediatamente em **Liberar fundos**. Liberações atrasadas reduzem a avaliação do vendedor; atrasos graves ou repetidos marcam o vendedor como **não confiável** e afetam as próximas negociações.

Assim que confirma o recebimento, o vendedor toca em **Liberar fundos**; a plataforma assina junto e o BIG vai para o endereço de recebimento do comprador. A assinatura do vendedor mais a da plataforma bastam para concluir a liberação, e nenhuma das partes consegue movimentar o dinheiro sozinha.

Como o vendedor recebe diretamente, não existe uma etapa extra de envio de moeda fiduciária e a negociação termina em seguida.

![Custódia liberada](assets/screenshots/p2p-cny-wechat-13-escrow-released-pt.png)

![Concluído](assets/screenshots/p2p-cny-wechat-14-completed-pt.png)

O status passa a **Concluído**.

---

## 9. Opcional: disputa decidida com apoio da plataforma

Se as partes discordarem sobre o pagamento (valor diferente, pagamento não recebido, vendedor que não libera e assim por diante), qualquer uma delas pode congelar a negociação e abrir uma disputa. A plataforma confere a custódia e o comprovante de pagamento e decide: **liberar o BIG para o comprador** ou **devolver o dinheiro ao vendedor**.

Derrotas em disputas e atrasos repetidos ficam registrados na reputação do vendedor e, em casos graves, ele é marcado como **não confiável**.

---

## 10. Expiração ou falha → reembolso

Se o comprador nunca pagar, o vendedor pode deixar a negociação expirar; o BIG que está na custódia volta para o vendedor sem precisar do acordo do comprador.

Nenhuma das partes fica com o dinheiro da outra.

---

## 11. Opcional: "Verificar com meu celular" (comprador, liberação atrasada)

Esta não é uma etapa obrigatória da liquidação normal. O comprador só vê **"Verificar com meu celular"** quando o vendedor atrasa a liberação (mais de **30 minutos** depois de o comprador informar o pagamento, ou depois de confirmado e ainda sem liberação) **ou** quando uma disputa já foi aberta.

A opção aparece apenas para **Alipay e banco**, porque o comprador consegue ler o comprovante de transferência; no WeChat só o recebedor tem notificação e o PayPal não tem ponte de leitura, então nesses casos ela não aparece. O comprador faz uma leitura com o próprio celular pareado, a carteira assina e envia o resultado; a verificação fica registrada na reputação do vendedor, mas não substitui a liberação que o vendedor deve fazer o quanto antes.

---

## Comparação: Binance P2P e esta liquidação

| Recurso | Binance P2P | Esta liquidação |
|---|---|---|
| Verificação da moeda fiduciária | O vendedor clica em "confirmar" (sistema de reputação) | O vendedor confere no próprio extrato e a plataforma libera conforme o fluxo |
| Custódia da moeda fiduciária | Plataforma (comprador → vendedor) | O comprador paga direto ao vendedor; a plataforma não intermedeia a moeda fiduciária |
| Custódia | Livro interno da plataforma | Custódia 2 de 3 na blockchain, verificável publicamente |
| Reembolso | Ticket para o suporte | A negociação expira e o BIG volta automaticamente ao vendedor |
| Resolução de disputas | Atendimento humano (vários dias) | Disputa no aplicativo + decisão da plataforma (mais rápido) |

---

## Linha do tempo

```
Correspondido        14:20  valor fixado no momento da correspondência
Custódia bloqueada   14:23  vendedor envia o BIG e o aplicativo confirma o recebimento
Aguardando pagamento 14:24  comprador vê as instruções de pagamento
Pagamento informado  14:25  comprador paga e informa o número de série
Pagamento confirmado 14:26  vendedor confere no próprio extrato
Custódia liberada    14:27  vendedor e plataforma assinam juntos, o BIG vai para o comprador
Concluído            14:27  negociação encerrada
```

---

Para entender detalhes de implementação, como a máquina de estados, as assinaturas, os scripts de custódia e as interfaces, consulte a documentação para desenvolvedores em `docs/p2p.md`.
