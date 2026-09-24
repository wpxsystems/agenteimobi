-- Executado uma única vez pelo container do Postgres na criação do volume.
-- Cria o role da aplicação SEM SUPERUSER/BYPASSRLS. As senhas vêm das variáveis
-- do compose (psql -v), nunca ficam escritas aqui.
-- O POSTGRES_USER do container é o OWNER do banco e roda as migrations.

\set app_password `echo "$AIM_APP_PASSWORD"`

CREATE ROLE aim_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
GRANT CONNECT ON DATABASE agente_imobi TO aim_app;
GRANT USAGE ON SCHEMA public TO aim_app;
