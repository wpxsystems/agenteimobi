-- Setup do banco no PostgreSQL local (sem Docker). Rodar como superusuário (postgres):
--   psql -U postgres -f docker/postgres/init-local.sql
-- As senhas devem bater com POSTGRES_PASSWORD e AIM_APP_PASSWORD do .env.

CREATE ROLE aim_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB PASSWORD 'TROCAR_SENHA_OWNER';
CREATE ROLE aim_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'TROCAR_SENHA_APP';
CREATE DATABASE agente_imobi OWNER aim_owner;
GRANT CONNECT ON DATABASE agente_imobi TO aim_app;
\connect agente_imobi
ALTER SCHEMA public OWNER TO aim_owner;
GRANT USAGE ON SCHEMA public TO aim_app;
