# Plano de implementação: produto simples para pequenas imobiliárias e corretores autônomos

Objetivo: transformar o MVP em um produto que o cliente contrata e usa sozinho, sem implantação humana, cobrindo com rotinas simples as funções que a Simbiose vende como agentes separados.

Público inicial: imobiliárias de até dez corretores e corretores autônomos com CRECI. Proprietário pessoa física fica para depois do piloto.

**Situação em 25/09/2026:** fases 0 e 1 implementadas e testadas, com a documentação em `docs/logica/` e `docs/lgpd/`. Pendências externas antes de vender:
- aprovação do app da Meta como Tech Provider, para o item 1.2;
- chave e teste do Asaas no sandbox, para o item 1.3;
- preços definitivos em `src/config/plans.js`;
- conta no Resend com domínio verificado;
- revisão jurídica das páginas `/privacidade`, `/privacidade/atendimento` e `/termos`, com os campos `[A PREENCHER]`.

Fase 2 implementada e testada em 25/09/2026: avisos, resumo diário e agenda de visitas (`docs/logica/rotina-do-dono.md`). Os templates do resumo e do lembrete dependem da aprovação da Meta.

Próximo passo: piloto com 5 a 10 imobiliárias antes da fase 3. O item 3.3 pode entrar antes, porque não depende de nada.

Princípios que valem para todas as fases:

- **Um assistente, várias rotinas.** A IA só conversa e escreve texto. Alertas, resumos, limites, agenda e disparos são código determinístico no backend, como a classificação já é hoje.
- **O painel é o CRM.** Nenhuma funcionalidade depende de integrar um sistema do cliente.
- **Padrões atuais do projeto.** Tabelas com prefixo `aim_`, `tenant_id` com RLS FORCE, migrations idempotentes e reversíveis, acesso pelo role `aim_app` via `inTx`, saída da IA validada com Zod, nenhum dado pessoal em log.
- **Cada item fecha com teste e documentação.** Funções puras ganham teste unitário, fluxos com banco ganham teste de integração (`TEST_DB=1`), e `docs/logica/` é atualizado.

Tamanho relativo de cada item: **P** até 2 dias, **M** de 3 a 5 dias, **G** mais de uma semana.

---

## Fase 0: fundação

Sem estes três itens, as fases seguintes quebram com mais de um cliente.

### 0.1 Fila de jobs no banco (M)

Hoje o debounce da resposta fica em memória (`scheduleReply` em `conversation.service.js`) e uma mensagem pode se perder se o processo cair logo após o 200 do webhook.

- Migration `0003_fila_jobs`: tabela `aim_job` com `id`, `tenant_id`, `kind`, `lead_id`, `payload jsonb`, `run_at`, `status` (`pendente`, `executando`, `feito`, `falhou`), `attempts`, `last_error`, `locked_at`.
- Índice único parcial em `(lead_id)` onde `kind = 'reply' AND status = 'pendente'`. Nova mensagem do lead faz upsert e empurra o `run_at`, o que substitui o debounce em memória.
- O webhook grava o evento como job `inbound` antes de responder 200. O processamento sai do caminho da requisição.
- Worker em `src/jobs/worker.js` reivindica lotes com `FOR UPDATE SKIP LOCKED`. Como o worker atende todos os tenants, a reivindicação passa por uma função `aim_claim_jobs(limit)` com `SECURITY DEFINER`, dona `aim_owner`, que devolve só `id`, `tenant_id` e `kind`. O processamento de cada job continua dentro de `inTx(tenant_id)`.
- Reprocessamento com backoff e limite de tentativas. Job que esgota tentativas gera aviso de qualidade (item 2.2).
- O job de follow-up e o `recoverUnanswered` passam a enfileirar em vez de executar direto.

### 0.2 Token do WhatsApp por conta, criptografado (P)

Hoje há um `WA_ACCESS_TOKEN` único para todas as contas.

- Colunas novas em `aim_tenant`: `wa_waba_id`, `wa_access_token_enc bytea`, `wa_token_updated_at`.
- Criptografia AES-256-GCM com chave `WA_TOKEN_ENC_KEY` no `.env`, em um módulo `src/services/crypto.js`. O token nunca sai em serializer nem em log.
- `whatsapp/client.js` passa a receber o tenant e usa o token dele. O token global vira apenas fallback de desenvolvimento.
- O `WA_APP_SECRET` continua global, porque todas as contas assinam o mesmo app da Meta.

### 0.3 Registro de uso por conta (P)

- Tabela `aim_usage_month`: `tenant_id`, `month`, `conversations`, `ai_calls`, `templates_sent`, `ad_copies`. Chave única `(tenant_id, month)`.
- Incremento atômico em `processReply`, no envio de template e no gerador de anúncio.
- Uma conversa conta uma vez por lead por mês, na primeira resposta da IA.
- Nesta fase só mede. O bloqueio por limite vem no item 1.4.

---

## Fase 1: produto que se vende sozinho

### 1.1 Cadastro sozinho e onboarding (M)

- Rota pública `POST /api/v1/signup` com rate limit forte: nome da conta, slug, nome, e-mail, senha e aceite dos termos.
- O role `aim_app` só lê `aim_tenant`. A criação de conta e do primeiro admin passa por uma função `aim_create_tenant(...)` com `SECURITY DEFINER`, que valida o slug e grava tudo numa transação.
- Confirmação de e-mail com link de uso único e validade curta. Conta não confirmada não conecta WhatsApp.
- Aceite registrado com data e versão dos termos e da política, em `aim_consent`.
- Rota de redefinição de senha pelo mesmo mecanismo de link.
- Assistente de primeiro uso no painel, em cinco passos: dados da conta, primeiro imóvel, conectar WhatsApp, copiar o link do anúncio, testar no simulador. O progresso fica salvo na conta.

### 1.2 Conectar o WhatsApp pelo cadastro incorporado da Meta (G)

É a maior barreira para quem não é técnico e o item com maior risco de prazo.

- Pré-requisito externo: o app da Meta precisa estar como Tech Provider, com empresa verificada e permissões `whatsapp_business_management` e `whatsapp_business_messaging` aprovadas. **Iniciar esse pedido na semana 1**, porque a aprovação leva semanas.
- No painel, botão "Conectar WhatsApp" abre o fluxo da Meta pelo SDK JavaScript do Facebook. Isso exige liberar `connect.facebook.net` e `facebook.com` na CSP do Helmet, só na página de conexão.
- `POST /api/v1/whatsapp/connect` recebe o código do fluxo, troca pelo token da empresa, lê `waba_id` e `phone_number_id`, assina o app na WABA, registra o número e grava tudo criptografado (item 0.2).
- Tela de status da conexão: número, nome exibido, qualidade do número e limite de mensagens informados pela Meta.
- Desconectar: apaga o token e desliga o bot da conta.

### 1.3 Planos e cobrança (M)

- Planos definidos em código (`src/config/plans.js`), com limites de conversas por mês, imóveis ativos, usuários e templates.
- Tabela `aim_subscription`: `tenant_id`, `plan`, `status` (`teste`, `ativa`, `inadimplente`, `cancelada`), `trial_ends_at`, `current_period_end`, ids do provedor.
- Provedor sugerido: Asaas, pela cobrança recorrente com PIX, boleto e cartão no Brasil. Integração por um módulo `src/services/billing/`, para trocar de provedor sem mexer no resto.
- Webhook `POST /webhooks/billing` com validação do token do provedor e idempotência por id do evento.
- Teste grátis sem cartão, com prazo fixo.
- Inadimplência: aviso no painel, carência de alguns dias e depois o bot para de atender leads novos. Conversas em andamento nunca são cortadas no meio.

### 1.4 Limite por plano (P)

- Verificação antes da chamada à IA em `processReply`, usando `aim_usage_month`.
- Ao atingir o limite, lead novo é transferido para humano com a mensagem padrão, e o dono recebe aviso. Lead já em conversa continua sendo atendido até o fim do mês.
- Aviso no painel ao chegar a 80% do limite.
- Tela "Uso do mês" com conversas, templates e dias restantes.

### 1.5 LGPD mínimo para vender (M)

Os pontos já listados como abertos em `docs/logica/atendimento-whatsapp.md`:

- Páginas públicas de política de privacidade e termos de uso, citando o envio do texto das conversas ao provedor de IA nos Estados Unidos.
- Exclusão de lead a pedido do titular: anonimiza o lead e apaga as mensagens, com registro de quem pediu e quando.
- Exportação dos dados de um lead em JSON, para atender pedido do titular.
- Job de retenção: apaga mensagens de leads encerrados após um prazo configurável por conta.
- Exclusão da conta inteira pelo admin, com confirmação.

---

## Fase 2: controle para o dono

Cobre o que a Simbiose vende como Iago, Mônica e parte da Sofia.

### 2.1 Resumo diário no WhatsApp (P)

- Coluna `timezone` em `aim_tenant`, padrão `America/Sao_Paulo`.
- Job que roda de hora em hora e envia para cada conta cujo relógio local passou das 8h e que ainda não recebeu o resumo do dia. Idempotência por tabela `aim_digest_sent` com chave `(tenant_id, day)`.
- Conteúdo: leads quentes aguardando o corretor e há quanto tempo, leads novos de ontem por classificação, visitas do dia e avisos pendentes.
- Envio por template de categoria utilidade, com variáveis numéricas e o link do painel. O mesmo resumo aparece no topo do painel.
- Dia sem nada relevante não gera envio.

### 2.2 Avisos de qualidade (M)

- Tabela `aim_alert`: `tenant_id`, `lead_id`, `property_id`, `kind`, `details jsonb`, `created_at`, `resolved_at`. Índice único parcial por `(lead_id, kind)` enquanto não resolvido, para não duplicar.
- Regras em funções puras em `src/services/quality.js`, executadas por job a cada 15 minutos:
  - **Lead quente sem retorno:** transferido e sem mensagem humana depois de um prazo configurável.
  - **Mensagem sem resposta:** o lead escreveu, o bot está ligado e nada saiu após as tentativas de recuperação.
  - **Falha de envio:** erro da Meta ao enviar, gravado a partir do `catch` de `sendAndRecord`.
  - **Resposta inválida da IA:** saída reprovada no Zod mais de uma vez para o mesmo lead.
  - **Cadastro incompleto:** imóvel com três ou mais dúvidas sem resposta de leads diferentes, sugerindo o que acrescentar no campo de informações extras.
- Rotas `GET /api/v1/alerts` e `PATCH /api/v1/alerts/:id`.
- No painel: contador no menu, lista com link para o lead ou imóvel e botão "Resolvido". Um aviso de cadastro incompleto se resolve sozinho quando o imóvel é editado.
- Sem IA nesta versão. Uma revisão por IA das conversas pode vir depois, sobre os mesmos registros.

### 2.3 Agendamento de visita (G)

- Coluna `visit_schedule jsonb` em `aim_tenant` com os horários por dia da semana e a duração da visita.
- Tabela `aim_visit`: `tenant_id`, `lead_id`, `property_id`, `starts_at`, `status` (`agendada`, `cancelada`, `realizada`, `nao_compareceu`), `created_by`. Índice único em `(tenant_id, property_id, starts_at)` onde status é `agendada`, para impedir dois agendamentos no mesmo horário.
- Função pura `freeSlots(schedule, visits, now, days)` que calcula os horários livres dos próximos sete dias.
- O prompt recebe até seis horários livres quando o lead está qualificado para visita.
- A ferramenta da IA ganha o campo `horario_visita`. O backend só aceita um valor que esteja entre os horários oferecidos naquela rodada e cria a visita em transação. Conflito de horário devolve novas opções.
- Status do lead vai para `visita_agendada`, e o dono recebe aviso pelo template de transferência.
- Lembrete ao lead na véspera por template, já que costuma estar fora da janela de 24 horas.
- No painel: aba "Agenda" com a lista do dia e da semana, e botões para remarcar, cancelar e marcar como realizada ou não comparecimento.
- O funil passa a usar `aim_visit` como fonte de visitas.

---

## Fase 3: crescimento

Cobre o que a Simbiose vende como Heitor, Lívia, Débora e parte do Téo.

### 3.1 Reativação de base (G)

Depende dos itens 0.1, 0.2 e 1.4.

- Tabelas `aim_campaign` (nome, template, idioma, filtros, limite diário, status, contadores) e `aim_campaign_target` (`campaign_id`, `lead_id`, status `pendente`, `enviado`, `falhou`, `respondeu`, `saiu`, `sent_at`, `wa_message_id`). Chave única `(campaign_id, lead_id)`.
- Filtros: classificação, status, imóvel, origem e dias sem contato.
- Exclusões obrigatórias: opt-out, leads com conversa ativa e leads que receberam campanha nos últimos 30 dias.
- Lista de templates aprovados lida da Meta pela WABA da conta.
- Antes de disparar, o painel mostra quantos leads serão atingidos e o custo estimado de templates de marketing. O disparo exige confirmação.
- Envio pela fila, respeitando o limite diário da campanha e o limite de mensagens do número.
- O template inclui um botão de resposta rápida para parar de receber, que grava opt-out.
- Resposta de lead com envio pendente de campanha marca `respondeu`, liga o bot, zera o follow-up e devolve o lead ao fluxo normal de atendimento.
- Tela "Reativação" com resultado por campanha: enviados, respostas, leads que voltaram a quente e visitas geradas.

### 3.2 Gerador de texto de anúncio (P)

- `POST /api/v1/properties/:id/ad-copy` com o canal (Marketplace, OLX, Instagram, Grupo de WhatsApp).
- A IA recebe só o cadastro do imóvel, as dúvidas mais frequentes dos leads e o link rastreado do canal. Devolve três variações validadas por Zod, com tamanho máximo por canal.
- O prompt proíbe informação fora do cadastro e linguagem discriminatória.
- Nada é gravado. O uso conta em `aim_usage_month`.
- No painel: botão "Gerar anúncio" na tela do imóvel, com botão de copiar em cada variação.

### 3.3 Origem que gera lead quente (P)

- O link rastreado passa a aceitar `utm_campaign` e `utm_content`, gravados em `aim_link_click`.
- O texto pré-preenchido do WhatsApp ganha uma referência curta do clique, lida pelo parser do webhook. Assim o lead fica ligado ao clique e à campanha exata.
- O dashboard de Anúncios passa a mostrar leads quentes e visitas por origem e por campanha, não só cliques.

---

## Fase 4: depois do piloto

Decidir com base no uso real:

- Vários corretores por conta com distribuição de leads em rodízio.
- Pódio semanal dos corretores, que só faz sentido com o item anterior.
- Atendimento pelo Instagram Direct, reaproveitando o parser do webhook da Meta.
- Transcrição de áudio do lead.
- Envio do evento "lead qualificado" para a Meta, para as campanhas otimizarem por qualidade.

---

## Ordem e dependências

| Ordem | Item | Depende de |
|---|---|---|
| 1 | Pedido de Tech Provider na Meta | nada, é externo e lento |
| 2 | 0.1 Fila de jobs | nada |
| 3 | 0.2 Token por conta | nada |
| 4 | 0.3 Registro de uso | nada |
| 5 | 1.1 Cadastro e onboarding | nada |
| 6 | 1.2 Conexão do WhatsApp | 0.2, 1.1 e aprovação da Meta |
| 7 | 1.3 Planos e cobrança | 1.1 |
| 8 | 1.4 Limite por plano | 0.3, 1.3 |
| 9 | 1.5 LGPD mínimo | nada |
| 10 | 2.1 Resumo diário | 0.1 |
| 11 | 2.2 Avisos de qualidade | 0.1 |
| 12 | 2.3 Agendamento de visita | nada |
| 13 | Piloto com 5 a 10 clientes | fases 0, 1 e 2 |
| 14 | 3.1 Reativação | 0.1, 0.2, 1.4 |
| 15 | 3.2 Gerador de anúncio | 0.3 |
| 16 | 3.3 Origem de lead quente | nada |

Os itens 1.5, 2.3 e 3.3 não dependem de nada e podem andar em paralelo se houver mais de uma pessoa.

## Piloto

Entrar no piloto com as fases 0, 1 e 2 prontas. Medir por conta, por mês:

- Leads atendidos e tempo até a primeira resposta.
- Leads quentes e visitas agendadas.
- Leads quentes que esperaram o corretor além do prazo.
- Custo de IA e de templates por conta, comparado ao preço do plano.
- Contas que concluíram o onboarding sem ajuda.

O número de leads quentes e visitas por mês vira o argumento de venda.

## Decisões pendentes

- Provedor de cobrança: Asaas é a sugestão.
- Provedor de e-mail transacional para confirmação e redefinição de senha.
- Preço e limites de cada plano, calculados a partir do custo medido no item 0.3.
- Prazo padrão de retenção das conversas.
- Se o app da Meta será registrado em nome da WPX como Tech Provider ou de outra empresa.
