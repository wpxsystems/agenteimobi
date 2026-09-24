# AgenteImobi

Atendimento automatizado com IA pelo WhatsApp para imóveis. O lead clica no link do anúncio, conversa com a IA, é qualificado e classificado (quente, morno, frio) e, quando está pronto para visitar, é transferido para o corretor.

**Stack:** Node 20, Express, Sequelize, PostgreSQL 16 (RLS), Zod, JWT, pino, WhatsApp Cloud API (oficial) e Claude (Anthropic).

Como funciona por dentro (fluxo, regras de classificação, contratos e testes): [`docs/logica/atendimento-whatsapp.md`](docs/logica/atendimento-whatsapp.md).

## Como o lead chega

```
Anúncio (Marketplace/Instagram/OLX)  →  link rastreado /r/<conta>/<CODIGO>?src=marketplace
   → conta o clique → abre wa.me com "Olá! Tenho interesse no imóvel #CODIGO"
   → webhook → IA conversa e qualifica → classificação no backend → transfere o quente ao corretor
```

## O que a assistente faz

- Responde dúvidas só com os dados cadastrados do imóvel e coleta renda, garantia, moradores, pet, prazo e interesse em visita.
- A classificação (quente, morno, frio) é calculada no backend a partir desses fatos, nunca pela IA.
- **Alternativas compatíveis:** se o imóvel não serve (pet, renda, garantia, moradores), o backend calcula quais outros imóveis ativos servem e a IA oferece o mais parecido; se o lead aceitar, a conversa passa a ser sobre ele.
- **Resumo para o corretor:** ao transferir, a IA escreve um resumo da conversa (quem é, o que quer, o que foi combinado). Se a transferência for automática, o backend gera o resumo a partir dos fatos.
- **Dúvidas sem resposta:** o que o lead perguntou e o cadastro não respondia fica registrado no lead e agregado por imóvel, para o dono completar as informações.

## 1. Configurar o WhatsApp Cloud API (Meta)

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app do tipo **Business** e adicione o produto **WhatsApp**.
2. Cadastre e verifique o número da imobiliária. Anote o **Phone number ID**, que vai em `SEED_WA_PHONE_NUMBER_ID`.
3. Crie um **usuário do sistema** no Business Manager e gere um token permanente com `whatsapp_business_messaging`. Ele vai em `WA_ACCESS_TOKEN`.
4. Copie o **App Secret** (Configurações > Básico) para `WA_APP_SECRET`.
5. Configure o webhook:
   - URL: `https://<seu-dominio>/webhooks/whatsapp`
   - Verify token: o mesmo valor de `WA_VERIFY_TOKEN`
   - Assine o campo **messages**.
6. (Opcional) Crie e aprove um template para alertar o dono sobre leads transferidos, com 4 variáveis: nome, imóvel, classificação e preferência de visita. Coloque o nome dele em `WA_OWNER_ALERT_TEMPLATE`.

> Para testar antes de verificar o número, a Meta oferece um número de teste que só envia mensagens para até 5 números cadastrados.

## 2. Subir o ambiente

```bash
cp .env.example .env        # preencher segredos
docker compose up -d --build
docker compose exec api node src/db/seed-dev.js
```

Sem Docker (Postgres já criado com os roles de `docker/postgres/init.sql`):

```bash
npm install
npm run migrate
npm run seed:dev
npm run dev
```

O webhook precisa de uma URL HTTPS pública. Em desenvolvimento, use um túnel (ex.: cloudflared ou ngrok) e aponte `PUBLIC_BASE_URL` para ele.

### Painel e simulador (teste visual, sem WhatsApp real)

Com a API no ar, abra `http://localhost:<PORT>/painel/` e entre com a conta do seed (`SEED_TENANT_SLUG`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`). Com `DEV_AUTO_LOGIN=true` (só fora de produção) o painel entra sozinho como esse admin, sem pedir senha; "Sair" volta para a tela de entrada até você escolher entrar de novo. O painel mostra leads com a ficha de qualificação e o carimbo quente/morno/frio, os imóveis com o link do anúncio, e três dashboards (Funil, Anúncios e Atendimento) com filtro de período e imóvel, gráficos com tabela equivalente e exportação em Excel/CSV. O menu lateral pode ser recolhido e o tema (claro/escuro) é escolhido no próprio painel; as duas preferências ficam salvas no navegador.

Fora de produção (`NODE_ENV` diferente de `production`) o painel ganha um simulador: **Simular um lead novo** cria uma conversa como se um cliente tivesse chegado pelo anúncio, e **Enviar como o lead** passa a mensagem pelo mesmo fluxo do webhook (rota `POST /api/v1/dev/inbound`). Com `WA_MOCK=true` nada é enviado para a Meta; a resposta da assistente fica só no banco e aparece no painel. A assistente só responde com `ANTHROPIC_API_KEY` preenchida.

Os arquivos do painel ficam em `public/painel` e são servidos pela própria API (no compose, a pasta é montada no container, então editar não exige rebuild).

## 3. Colocar a casa do cliente no ar

```bash
# login
curl -X POST $API/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"tenant":"cliente-teste","email":"admin@...","password":"..."}'

# cadastrar/editar o imóvel (valores em centavos)
curl -X PATCH $API/api/v1/properties/<id> -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Casa 3 quartos no Centro","priceCents":250000,"feesCents":20000,"allowsPets":true,
       "maxOccupants":5,"acceptedGuarantees":["caucao","seguro_fianca"],"locationSummary":"Centro - Cidade",
       "description":"...","extraInfo":"Garagem para 2 carros. Visitas de seg a sáb."}'

# pegar o link para colar no anúncio
curl $API/api/v1/properties/<id>/links?src=marketplace -H "authorization: Bearer $TOKEN"
```

Coloque o `trackedLink` na descrição do anúncio (ex.: "Atendimento imediato no WhatsApp: <link>"). O campo `extraInfo` é o que a IA usa para responder dúvidas. Quanto mais completo, menos transferências para humano.

## API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/v1/auth/login` · `/refresh` · `/logout` | Autenticação (JWT 15 min + refresh 7 dias com rotação) |
| GET/POST | `/api/v1/properties` | Listar/criar imóveis (criar: admin) |
| GET/PATCH | `/api/v1/properties/:id` | Ver/editar imóvel (editar: admin) |
| GET | `/api/v1/properties/:id/links?src=` | Link wa.me e link rastreado |
| GET | `/api/v1/properties/:id/open-questions` | Perguntas dos leads que a IA não soube responder (o que falta no cadastro) |
| GET | `/api/v1/leads?classification=&status=&propertyId=` | Leads com classificação e qualificação |
| GET | `/api/v1/leads/export?format=csv\|xlsx&propertyId=&from=&to=` | Baixa os leads em CSV ou Excel (abas Leads e Resumo) |
| GET/PATCH | `/api/v1/leads/:id` | Conversa completa / mudar status, ligar ou desligar o bot |
| POST | `/api/v1/leads/:id/messages` | Corretor responde pelo sistema (assume a conversa) |
| GET | `/api/v1/metrics/funnel?propertyId=&from=&to=` | Cliques → conversas → qualificados → visitas |
| GET | `/api/v1/metrics/overview?propertyId=&from=&to=` | Funil + série diária + por imóvel + por origem + motivos de desqualificação + transferidos aguardando o corretor + tempo mediano até transferir |
| GET/POST | `/webhooks/whatsapp` | Webhook da Meta (assinatura validada) |
| GET | `/r/:slug/:code?src=` | Link rastreado público (conta o clique e redireciona) |

## Testes

```bash
npm test                          # unitários (sem banco)
TEST_DB=1 npm test                # + integração (Postgres de TESTE já migrado e com seed)
```

WhatsApp e Anthropic são mockados nos testes. Nenhuma mensagem real é enviada.

## Custos a considerar no teste
- **WhatsApp:** a Meta cobra por mensagem de template. Respostas dentro da janela de 24h iniciada pelo cliente não têm custo de template. Confira a tabela atual da Meta para o Brasil.
- **Anthropic:** uma chamada por rodada de conversa (mensagens em sequência são agrupadas).
