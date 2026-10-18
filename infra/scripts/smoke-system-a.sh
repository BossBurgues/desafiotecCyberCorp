#!/usr/bin/env bash
# Smoke do container do Sistema A. Uso: bash infra/scripts/smoke-system-a.sh <imagem>
# Credenciais de teste são geradas aqui e nunca impressas.
set -euo pipefail

IMAGE="${1:?uso: smoke-system-a.sh <imagem>}"
SUFFIX="$$-$(date +%s)"
NAME="smoke-system-a-$SUFFIX"
VOLUME="smoke-system-a-data-$SUFFIX"
PORT="${SMOKE_PORT:-13001}"
BASE="http://127.0.0.1:$PORT"

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
APP_TOKEN="$(rand)"; TEC_PASS="$(rand)"; EST_PASS="$(rand)"; BOT_TOKEN="$(rand)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ok() { echo "OK    $1"; }
fail() { echo "FALHA $1" >&2; exit 1; }

start_container() {
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3001" -v "$VOLUME:/data" \
    -e A_APP_TOKEN="$APP_TOKEN" -e A_TECNICO_PASSWORD="$TEC_PASS" \
    -e A_ESTAGIARIO_PASSWORD="$EST_PASS" -e A_SYNC_BOT_TOKEN="$BOT_TOKEN" \
    "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy" ] && return 0
    sleep 1
  done
  docker logs "$NAME" 2>&1 | tail -20 >&2
  return 1
}

new_session() {
  local auth
  auth="$(printf 'tecnico:%s' "$TEC_PASS" | base64 | tr -d '\n')"
  curl -fsS "$BASE/apirest.php/initSession" -H "App-Token: $APP_TOKEN" \
    -H "Authorization: Basic $auth" | sed -E 's/.*"session_token":"([^"]+)".*/\1/'
}

# 1. não roda como root
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
[ "$uid" != "0" ] && ok "1 usuário do processo não é root (uid $uid)" || fail "1 container roda como root"

# 2. sobe e fica saudável
start_container
wait_healthy && ok "2 container ficou healthy" || fail "2 container não ficou healthy em 30 s"

# 3. sessão e listagem
SESSION="$(new_session)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/apirest.php/Ticket" -H "App-Token: $APP_TOKEN" -H "Session-Token: $SESSION")"
[ "$code" = "200" ] || [ "$code" = "206" ] && ok "3 initSession + GET /Ticket ($code)" || fail "3 GET /Ticket devolveu $code"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/apirest.php/Ticket")"
[ "$code" = "401" ] && ok "3 GET /Ticket sem token = 401" || fail "3 GET /Ticket sem token devolveu $code"

# 4. dado sobrevive a restart (volume)
created="$(curl -fsS -X POST "$BASE/apirest.php/Ticket" -H "App-Token: $APP_TOKEN" -H "Session-Token: $SESSION" \
  -H 'Content-Type: application/json' -d '{"input":{"name":"smoke","content":"smoke do container"}}')"
ID="$(echo "$created" | sed -E 's/.*"id":([0-9]+).*/\1/')"
[[ "$ID" =~ ^[0-9]+$ ]] || fail "4 POST /Ticket não devolveu id: $created"
docker restart "$NAME" >/dev/null
wait_healthy || fail "4 container não voltou healthy após restart"
SESSION="$(new_session)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/apirest.php/Ticket/$ID" -H "App-Token: $APP_TOKEN" -H "Session-Token: $SESSION")"
[ "$code" = "200" ] && ok "4 chamado $ID persistiu após restart" || fail "4 chamado $ID sumiu após restart ($code)"

# 5. parada rápida e limpa
t0=$(date +%s)
docker stop "$NAME" >/dev/null
elapsed=$(( $(date +%s) - t0 ))
exitcode="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$elapsed" -lt 5 ] && [ "$exitcode" = "0" ] && ok "5 docker stop em ${elapsed}s com código 0" || fail "5 docker stop levou ${elapsed}s, código $exitcode"

# 6. negativo: sem credenciais não sobe
set +e
out="$(docker run --rm "$IMAGE" 2>&1)"; rc=$?
set -e
[ "$rc" -ne 0 ] && echo "$out" | grep -q "A_APP_TOKEN" && ok "6 sem credenciais o container sai com código $rc" || fail "6 container subiu sem credenciais (rc=$rc)"

# 7. negativo: código somente leitura
if docker run --rm --entrypoint sh "$IMAGE" -c 'touch /app/x' >/dev/null 2>&1; then
  fail "7 usuário conseguiu gravar em /app"
else
  ok "7 /app é somente leitura para o usuário do container"
fi

echo "Smoke do Sistema A: tudo OK"
