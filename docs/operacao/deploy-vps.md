# Deploy do agenteimobi no vps2

O agenteimobi é um **app novo** e vai direto para o **vps2** (195.35.43.173), seguindo o
`wpx-infra/docs/app-novo.md`. O servidor antigo (`wpx`, 72.60.50.139) está sendo esvaziado e não
recebe apps novos (`wpx-padroes/references/11-servidores-atuais.md`).

Modelo: push na `main` → Actions testa e monta a imagem → envia pela chave deste app → o vps2
valida, sobe, confere a saúde e volta a versão anterior se falhar.

| Item | Valor |
|---|---|
| Nome do app | `agenteimobi` |
| Imagem | `wpx/agenteimobi-api` (um serviço só: API + painel estático) |
| Endereço | `https://imobi.wpxsystems.com.br` |
| Banco | `agenteimobi`, no Postgres compartilhado do vps2 |
| Arquivos de produção | `deploy/vps2/` deste repo → `wpx-infra/server/config/agenteimobi/` |

## Checklist (`app-novo.md`)

```
[ ] 1  nomes das imagens: wpx/agenteimobi-api            (feito neste repo)
[ ] 2  config no wpx-infra: server/config/agenteimobi/    (copiar deploy/vps2/compose.yml e deploy.conf)
[ ] 3  agenteimobi no case dos dois scripts + base reinstalada no vps2      (admin)
[ ] 4  banco e papéis criados                              (admin, ver abaixo)
[ ] 5  /etc/wpx/agenteimobi/ com compose, deploy.conf e .env               (admin)
[ ] 6  chave ci-wpx-agenteimobi + onboard-projeto.sh      (admin)
[ ] 7  secrets no GitHub                                   (admin)
[ ] 8  workflow deploy.yml a partir do template            (ver abaixo)
[ ] 9  DNS: A imobi → 195.35.43.173 no Registro.br         (dono do domínio)
[ ] 10 testes: deploy, separação, rollback, backup
[ ] 11 apagar a chave de CI do PC
```

## Passo 4 — Banco: diferença em relação ao padrão `_app`/`_auth`

Este app separa **dono** e **aplicação** (as migrations criam policies e funções SECURITY DEFINER que
pertencem ao dono; a aplicação roda sem BYPASSRLS e com FORCE RLS). Por isso são dois papéis com
LOGIN, nenhum superusuário, e sem papel `_auth`:

```sql
-- no vps2: sudo docker exec -it postgres psql -U wpxadmin -d postgres
CREATE ROLE agenteimobi_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '<senha-owner>';
CREATE ROLE agenteimobi_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '<senha-app>';
CREATE DATABASE agenteimobi OWNER agenteimobi_owner;
REVOKE ALL ON DATABASE agenteimobi FROM PUBLIC;
GRANT CONNECT ON DATABASE agenteimobi TO agenteimobi_app;
\c agenteimobi
GRANT USAGE ON SCHEMA public TO agenteimobi_app;
```

As migrations rodam sozinhas na subida do container (com `DATABASE_MIGRATION_URL`) e dão ao
`agenteimobi_app` só os grants necessários (`DB_APP_ROLE=agenteimobi_app`). Nenhuma extensão é
necessária.

## Passo 5 — `.env` de produção

Modelo em `deploy/vps2/env.producao.exemplo`. Os valores são gerados e digitados só no servidor.
`DEMO_MODE=true` deixa o WhatsApp simulado e o simulador de conversas ligado (só com login), para a
demonstração com a Curta. Quando o número real for conectado, trocar para `false`.

## Passo 8 — Workflow

Copiar `wpx-infra/server/templates/deploy.yml` para `.github/workflows/deploy.yml` e ajustar:

- `concurrency.group: deploy-agenteimobi`
- `needs:` com o job de teste deste repo (`npm ci && npm test`, sem banco)
- sem `VITE_GOOGLE_CLIENT_ID` e sem `environment:`
- build e pacote:

```yaml
docker build -t wpx/agenteimobi-api:"$GITHUB_SHA" .
docker save wpx/agenteimobi-api:"$GITHUB_SHA" | gzip -1 > image.tar.gz
```

O passo "Envia e implanta" fica igual ao template.

## Depois do primeiro deploy — conta de demonstração

```bash
# no vps2, com a senha numa variável (nunca em argumento)
read -rs CONTA_SENHA && export CONTA_SENHA
sudo -E docker exec -e CONTA_SENHA agenteimobi-agenteimobi-api-1 node src/db/conta-cli.js criar \
  --slug curta --nome "Curta! Imóveis" --admin-nome "Equipe Curta" \
  --admin-email equipe@curta-demo.com.br --assistente Bia
```

Confira o nome real do container com `sudo docker ps`. Depois cadastre os imóveis e os horários pelo
painel. Para gerar conversas de exemplo, rode no PC a avaliação apontando para a URL pública:

```bash
AVALIAR_API=https://imobi.wpxsystems.com.br/api/v1 AVALIAR_SENHA=<senha> npm run avaliar -- --conta curta --email equipe@curta-demo.com.br
```

## O que o `DEMO_MODE` liga e o que não liga

| Recurso | `DEMO_MODE=true` em produção |
|---|---|
| Mensagens para a Meta | não saem (simuladas) |
| Simulador de conversas no painel | ligado, só com login |
| Entrada automática sem senha | desligada |
| Caixa de e-mails local e simulação de cobrança | desligadas |
