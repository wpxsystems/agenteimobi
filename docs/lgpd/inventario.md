# LGPD: inventário, retenção, bases legais e direitos do titular

Derivado do código em 25/09/2026: migrations `0001` a `0008`, models, `services/ai`, `services/whatsapp`, `services/billing`, `services/email.service.js` e `services/privacy.service.js`.

> **RASCUNHO. Revisar juridicamente antes de publicar.** Este documento descreve o que o sistema faz tecnicamente. Não é parecer jurídico.

## 1. Papéis

| Quem | Papel | Sobre quais dados |
|---|---|---|
| WPX Systems, dona do Imobi | **Controladora** | dados das contas: imobiliária, usuários do painel, cobrança |
| WPX Systems | **Operadora** | dados dos leads, que a imobiliária recebe pelos anúncios dela |
| Imobiliária ou corretor cliente | **Controladora** | dados dos leads que atende pelo Imobi |

Consequência: o pedido de um lead para ver ou apagar os próprios dados é atendido pela imobiliária. O sistema dá a ela as ferramentas, nos botões "Baixar os dados" e "Excluir os dados" da ficha do lead.

## 2. Inventário de dados pessoais

### Contas (WPX controladora)

| Tabela.campo | Categoria | Base legal (Art. 7º) | Finalidade | Retenção |
|---|---|---|---|---|
| `aim_tenant.name`, `slug` | Identificação da empresa ou do corretor | Execução de contrato (V) | Identificar a conta e o endereço de entrada | até excluir a conta |
| `aim_tenant.owner_whatsapp` | Contato | Execução de contrato (V) | Avisar o dono de lead transferido | até excluir a conta |
| `aim_tenant.wa_display_phone`, `wa_phone_number_id`, `wa_waba_id` | Contato comercial | Execução de contrato (V) | Enviar e receber pelo WhatsApp da conta | até excluir a conta |
| `aim_tenant.wa_access_token_enc` | Credencial, cifrada | Execução de contrato (V) | Enviar mensagens em nome da conta | até excluir a conta ou desconectar |
| `aim_user.name`, `email` | Identificação e contato | Execução de contrato (V) | Entrar no painel, e-mails de conta | até excluir a conta |
| `aim_user.password_hash` | Credencial, bcrypt | Execução de contrato (V) | Autenticação | até excluir a conta |
| `aim_user.email_verified_at` | Registro | Execução de contrato (V) | Provar que o e-mail é da pessoa | até excluir a conta |
| `aim_user_token.token_hash` | Credencial, só o hash | Execução de contrato (V) | Links de confirmação e de nova senha | 48 h ou 1 h de validade; apagado 30 dias após usar ou vencer |
| `aim_refresh_token` (ids, datas) | Sessão | Execução de contrato (V) | Manter a sessão | 7 dias; apagado 30 dias após revogar ou vencer |
| `aim_consent` (documento, versão, data) | Registro de aceite | Cumprimento de obrigação (II) e defesa de direitos (VI) | Provar o aceite dos termos e da política | até excluir a conta |
| `aim_subscription.provider_customer_id`, `provider_subscription_id` | Financeiro, só referência | Execução de contrato (V) | Ligar a conta à cobrança no Asaas | até excluir a conta |
| CPF/CNPJ de quem paga | Identificação e financeiro | Execução de contrato (V) | Emitir a cobrança | **não é armazenado**: vai direto ao Asaas |

### Leads (imobiliária controladora, WPX operadora)

| Tabela.campo | Categoria | Base legal sugerida | Finalidade | Retenção |
|---|---|---|---|---|
| `aim_lead.wa_id` | Contato (telefone) | Procedimentos preliminares a contrato, a pedido do titular (V) | Responder quem escreveu | `retention_months` sem contato (padrão 12) ou pedido de exclusão |
| `aim_lead.display_name` | Identificação | idem | Tratar pelo nome | idem |
| `aim_lead.qualification.monthlyIncomeCents` | **Financeiro** | idem | Avaliar se o imóvel serve (renda de 2,5 a 3 vezes o aluguel) | idem |
| `aim_lead.qualification` (garantia, moradores, pet, prazo, quer visitar) | Perfil | idem | Qualificar e classificar | idem |
| `aim_lead.visit_preference`, `handoff_summary`, `handoff_reason`, `open_questions` | Texto livre sobre a pessoa | idem | Passar o atendimento ao corretor | idem |
| `aim_lead.classification`, `score`, `disqualify_reasons` | Perfil derivado | Legítimo interesse do controlador (IX) | Priorizar o atendimento | mantidos na anonimização, sem ligação com a pessoa |
| `aim_lead.opt_out_at`, `privacy_notice_sent_at` | Registro | Cumprimento de obrigação (II) | Respeitar o SAIR e provar o aviso | idem |
| `aim_message.body` | **Texto livre da conversa** | Procedimentos preliminares a contrato (V) | Histórico do atendimento, contexto da IA | idem, as mensagens são apagadas |
| `aim_job.payload` (telefone, nome, texto) | Cópia transitória | idem | Processar a mensagem na fila | apagado ao concluir; linha some em 24 h, ou 7 dias se falhar |
| `aim_privacy_request.subject_ref` | Pseudônimo (SHA-256 da conta com o telefone) | Cumprimento de obrigação (II) | Provar que o pedido foi atendido | até excluir a conta |

**Dados sensíveis (Art. 11):** o sistema não pede nenhum. Mas `aim_message.body` é texto livre e o lead pode escrever algo sensível, como saúde ou religião. Isso não é filtrado. Tratar como possível, e a retenção curta reduz o risco.

**Minimização:**
- O clique no link rastreado (`aim_link_click`) guarda só data, imóvel e origem, sem IP nem navegador.
- Os logs registram só ids e códigos de erro. E-mails aparecem mascarados, como `a***@dominio`.
- Não há campo coletado sem uso.

## 3. Retenção

| Dado | Prazo | Ação | Quem executa |
|---|---|---|---|
| Conversa e dados pessoais do lead | `retention_months` sem mensagens, de 3 a 24 meses, padrão 12, configurável no painel | anonimiza o lead e apaga as mensagens | `jobs/retention.job.js`, a cada 6 h |
| Idem, a pedido | na hora | idem | `DELETE /api/v1/leads/:id` |
| Payload da fila | ao concluir | `payload = {}`; a linha some em 24 h, ou 7 dias se falhou | `job.service.complete` e `aim_purge_jobs` |
| Links de uso único | 30 dias após usar ou vencer | apaga | job de retenção |
| Sessões | 30 dias após revogar ou vencer | apaga | job de retenção |
| Conta inteira | a pedido do admin | apaga em cascata e cancela a assinatura | `DELETE /api/v1/account` |
| Logs da aplicação | **a definir na hospedagem** | - | infraestrutura |
| Backups do banco | **a definir** | - | infraestrutura |

**O que a anonimização mantém:** classificação, pontuação, motivos de desqualificação, origem, imóvel e datas. O telefone vira um número fictício que começa com `000`. Nome, fatos, resumos, dúvidas e mensagens são apagados.

## 4. Direitos do titular (Art. 18)

| Direito | Lead | Usuário da conta |
|---|---|---|
| Confirmação e acesso | ✅ `GET /leads/:id/privacy-export` (admin) | ⚠️ vê os próprios dados no painel; não há exportação da conta |
| Correção | ❌ não há edição de nome ou fatos do lead | ❌ não há tela de perfil |
| Anonimização e exclusão | ✅ `DELETE /leads/:id` e retenção automática | ✅ `DELETE /account` (senha e endereço da conta) |
| Portabilidade | ✅ JSON do export; CSV e Excel da lista de leads | ⚠️ só os leads, em CSV e Excel |
| Informação sobre compartilhamento | ✅ política de privacidade (rascunho) | ✅ idem |
| Revogação e oposição | ✅ responder SAIR, que para na hora | ✅ excluir a conta |

**Lacunas, que viram tarefa:**
1. Editar nome e fatos do lead, para correção.
2. Tela de perfil do usuário, com nome e e-mail.
3. Exportação completa da conta.
4. Definir retenção de logs e backups na infraestrutura.

## 5. Operadores externos

| Operador | País | Dado compartilhado | Finalidade | Observação |
|---|---|---|---|---|
| Anthropic (Claude) | EUA | texto das conversas, nome do lead, fatos, dados dos imóveis | gerar as respostas da assistente | transferência internacional (Art. 33); conferir o DPA e as regras de uso de dados da API |
| Meta (WhatsApp Cloud API) | EUA e global | telefone, nome do perfil, mensagens | enviar e receber mensagens | a Meta também é controladora do WhatsApp |
| Asaas | Brasil | nome da conta, e-mail do admin, CPF/CNPJ de quem paga | cobrança recorrente | o CPF/CNPJ não fica no Imobi |
| Resend | EUA | nome e e-mail do usuário | e-mails de confirmação e senha | só com `EMAIL_PROVIDER=resend` |
| Google Fonts | EUA | IP e navegador de quem abre o painel | fontes do painel | trocar por fontes servidas pelo próprio sistema remove esse envio |
| Hospedagem (VPS) | **a preencher** | todos, armazenados | infraestrutura | - |

## 6. Rascunhos publicados
- `/privacidade`: política de privacidade da plataforma, em `public/privacidade.html`.
- `/privacidade/atendimento`: aviso para o lead, o link que a assistente manda na primeira mensagem. Arquivo `public/privacidade-atendimento.html`.
- `/termos`: termos de uso, em `public/termos.html`.

Todos trazem campos `[A PREENCHER]` com razão social, CNPJ, endereço, hospedagem e contato do encarregado. As versões ficam em `src/config/legal.js`. Ao mudar o texto, subir a versão, e o aceite novo fica registrado.
