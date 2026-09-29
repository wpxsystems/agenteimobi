# Deploy na VPS da WPX

O sistema roda na VPS compartilhada da WPX, atrás do Traefik (rede `wpxnet`), com HTTPS automático do
Let's Encrypt. Cada sistema da VPS tem um subdomínio de `wpxsystems.com.br`; este usa
`imobi.wpxsystems.com.br`.

## 1. DNS (uma vez)

No painel de DNS do domínio `wpxsystems.com.br`, crie um registro:

| Tipo | Nome  | Valor          |
|------|-------|----------------|
| A    | imobi | 72.60.50.139   |

Sem esse registro o Traefik não consegue emitir o certificado e o link não abre.

## 2. Código na VPS (uma vez)

```bash
ssh wpx
git clone https://github.com/wpxsystems/agenteimobi.git ~/agenteimobi
cd ~/agenteimobi
cp .env.example .env && chmod 600 .env
```

## 3. `.env` da VPS

Preencha no próprio servidor. Nunca commite. Diferenças em relação ao local:

```ini
APP_HOST=imobi.wpxsystems.com.br
PUBLIC_BASE_URL=https://imobi.wpxsystems.com.br
PRIVACY_URL=https://imobi.wpxsystems.com.br/privacidade/atendimento
CORS_ORIGINS=https://imobi.wpxsystems.com.br
LOG_LEVEL=info

# Senhas novas, só desta VPS (gerar com: openssl rand -hex 24)
POSTGRES_PASSWORD=...
AIM_APP_PASSWORD=...
JWT_ACCESS_SECRET=...   # openssl rand -hex 48
JWT_REFRESH_SECRET=...  # openssl rand -hex 48
WA_TOKEN_ENC_KEY=...    # openssl rand -hex 32

# Demonstração: WhatsApp simulado e simulador de conversas no painel.
# Trocar para false quando o número real da imobiliária for conectado.
DEMO_MODE=true
WA_APP_SECRET=...       # enquanto não houver app da Meta, qualquer texto
WA_VERIFY_TOKEN=...     # mín. 16 caracteres

ANTHROPIC_API_KEY=...
BILLING_ENABLED=false
SIGNUP_ENABLED=false
DEV_AUTO_LOGIN=false
```

`NODE_ENV=production` e as URLs do banco são definidas pelo `compose.vps.yml`.

## 4. Subir e atualizar

```bash
cd ~/agenteimobi
git pull
docker compose -f compose.vps.yml --env-file .env up -d --build
docker compose -f compose.vps.yml logs -f api   # migrations rodam sozinhas na subida
```

## 5. Criar a conta de demonstração

```bash
CONTA_SENHA='<senha forte>' docker compose -f compose.vps.yml exec -e CONTA_SENHA api \
  node src/db/conta-cli.js criar --slug curta --nome "Curta! Imóveis" --admin-nome "Equipe Curta" --admin-email equipe@curta-demo.com.br --assistente Bia
```

Depois, com o admin logado no painel, cadastre os imóveis e os horários de visita. Para gerar conversas de
exemplo, rode a avaliação do atendimento apontando para a URL pública (usa o simulador e chama a IA de verdade).

## O que o `DEMO_MODE` liga e o que não liga

| Recurso | `DEMO_MODE=true` em produção |
|---|---|
| Mensagens para a Meta | não saem (simuladas) |
| Simulador de conversas no painel | ligado, só com login |
| Entrada automática sem senha | desligada |
| Caixa de e-mails local e simulação de cobrança | desligadas |
