# Como rodar o piloto com uma imobiliária

Guia de operação para o teste com uma imobiliária real, antes do lançamento. Sem cobrança, sem cadastro público e sem e-mail.

## 1. Configuração (`.env` do servidor)

```env
NODE_ENV=production
BILLING_ENABLED=false     # sem cobrança: nenhuma conta tem limite nem vencimento; planos somem do painel
SIGNUP_ENABLED=false      # sem cadastro público: contas só pelo comando abaixo
EMAIL_PROVIDER=log        # sem e-mail: senha é definida e trocada pelo comando
WA_MOCK=false
PUBLIC_BASE_URL=https://<seu-dominio>
PRIVACY_URL=https://<seu-dominio>/privacidade/atendimento
WA_TOKEN_ENC_KEY=<64 caracteres hex>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

O restante segue o `.env.example`. `WA_APP_SECRET` e `WA_VERIFY_TOKEN` são do app da Meta, no passo 3.

## 2. Criar a conta da imobiliária

```bash
CONTA_SENHA='<senha inicial, 10+ caracteres>' npm run conta -- criar \
  --slug imob-exemplo --nome "Imobiliária Exemplo" \
  --admin-nome "Nome do dono" --admin-email dono@imobiliaria.com.br \
  --assistente "Sofia"
```

- **O que o comando cria:** a conta no plano interno, sem limite, com o admin já confirmado. Quando a cobrança for ligada, a conta continua sem limite.
- **Como a imobiliária entra:** no painel `https://<seu-dominio>/painel/`, com o endereço da conta (`imob-exemplo`), o e-mail e a senha.
- **Trocar a senha**, que também encerra as sessões abertas:
  ```bash
  CONTA_SENHA='<nova>' npm run conta -- senha --slug imob-exemplo --email dono@imobiliaria.com.br
  ```
- **Ver as contas:**
  ```bash
  npm run conta -- listar
  ```

## 3. Conectar o WhatsApp da imobiliária (sem esperar a aprovação de Tech Provider)

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app do tipo **Business** e adicione o produto **WhatsApp**. Use a conta Business da imobiliária, ou a sua com acesso delegado.
2. Cadastre e verifique o número da imobiliária. O número não pode estar em uso no app do WhatsApp comum. Anote o **Phone number ID** e o **WhatsApp Business Account ID** (WABA).
3. No Business Manager, crie um **usuário do sistema** e gere um token permanente com `whatsapp_business_messaging` e `whatsapp_business_management`.
4. **Webhook do app:** URL `https://<seu-dominio>/webhooks/whatsapp`, verify token igual a `WA_VERIFY_TOKEN`, e assine o campo **messages**. O **App Secret** vai em `WA_APP_SECRET`.
5. Grave na conta:
   ```bash
   WA_TOKEN_NEW='<token do passo 3>' npm run conta -- whatsapp --slug imob-exemplo \
     --phone-id <Phone number ID> --numero 55DDNNNNNNNNN \
     --dono 55DDNNNNNNNNN --waba <WABA ID>
   ```
   `--numero` é o WhatsApp da imobiliária e `--dono` é o celular que recebe os avisos. Os dois vão só com dígitos, com DDI e DDD.
6. **Templates, opcionais,** aprovados na WABA da imobiliária. O texto e a ordem das variáveis estão no `.env.example`.
   - `WA_OWNER_ALERT_TEMPLATE`: avisa o dono quando um lead é transferido. Sem ele, o aviso fica só no painel.
   - `WA_DAILY_DIGEST_TEMPLATE`: resumo das 8h. Sem ele, o resumo fica só na tela "Hoje".
   - `WA_VISIT_REMINDER_TEMPLATE`: lembrete de visita quando o lead não fala há mais de 24 h.

## 4. Preparar antes de ligar para os leads de verdade

- **Imóveis.** Cadastre com preço, condomínio, pet, número de moradores e garantias. Capriche em **Informações extras**: vaga, portaria, horários, o que está incluso. A assistente só responde o que está no cadastro.
- **Horários de visita.** Em "Conta e plano", configure os horários em que a imobiliária faz visitas. Sem horários, a assistente não marca visita sozinha e passa o lead para o corretor combinar.
- **Aviso de privacidade.** Preencha os campos `[A PREENCHER]` e `[CONFIRMAR]` em `public/privacidade-atendimento.html`, em `/privacidade/atendimento`. É o link que a assistente manda ao lead na primeira mensagem.
- **Teste em casa.** Mande mensagens para o número da imobiliária pelo link de um imóvel, que fica em Imóveis. Confira na tela Leads se a conversa, a classificação e a visita saem como esperado.
- **Link nos anúncios.** Use o link rastreado de cada imóvel. Ele conta os cliques e abre o WhatsApp já com o código do imóvel.

## 5. No dia a dia do piloto

- **Hoje:** quem está esperando o corretor, visitas do dia e avisos. Os avisos somem quando o problema se resolve.
- **Agenda:** marcar visita como realizada ou não compareceu, e remarcar.
- **Leads:** a conversa, a ficha e o resumo para o corretor. Para responder pelo painel, use "Responder como corretor". Isso desliga a assistente naquela conversa.
- **Conta e plano:** conversas e respostas da assistente no mês. São os números para calcular o custo e definir os preços.

## 6. Para lançar depois do piloto

`BILLING_ENABLED=true`, `SIGNUP_ENABLED=true` e `EMAIL_PROVIDER=resend`, com preços definidos em `src/config/plans.js`, Asaas configurado e páginas legais revisadas. Ver as pendências em `docs/plano/melhorias-produto-simples.md`.
