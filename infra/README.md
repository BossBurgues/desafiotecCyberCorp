# Infra

- `docker-compose.yml`: ambiente completo (local = produção)
- `docker-compose.e2e.yml`: overrides para a CI (caos agressivo)
- `caddy/`: reverse proxy com HTTPS automático
- `scripts/`: deploy e utilitários

Hospedagem: VM Oracle Always Free (plano B: Render + Neon). Issues: épico **E4**.
