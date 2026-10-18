#!/usr/bin/env bash
# Smoke do container do Sistema B. Uso: bash infra/scripts/smoke-system-b.sh <imagem>
set -euo pipefail

IMAGE="${1:?uso: smoke-system-b.sh <imagem>}"
SUFFIX="$$-$(date +%s)"
NAME="smoke-system-b-$SUFFIX"
VOLUME="smoke-system-b-data-$SUFFIX"
PORT="${SMOKE_PORT:-15002}"
BASE="http://127.0.0.1:$PORT"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ok() { echo "OK    $1"; }
fail() { echo "FALHA $1" >&2; exit 1; }

wait_healthy() {
  for _ in $(seq 1 40); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = "healthy" ] && return 0
    sleep 1
  done
  docker logs "$NAME" 2>&1 | tail -20 >&2
  return 1
}

# 1. não roda como root
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
[ "$uid" != "0" ] && ok "1 usuário do processo não é root (uid $uid)" || fail "1 container roda como root"

# 2. sobe e fica saudável (HEALTHCHECK usa o modo --healthcheck do binário)
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5002" -v "$VOLUME:/data" "$IMAGE" >/dev/null
wait_healthy && ok "2 container ficou healthy" || fail "2 container não ficou healthy em 40 s"

# 3. contrato mínimo: criar e listar
created="$(curl -fsS -X POST "$BASE/api/v2/records" -H 'Content-Type: application/json' \
  -d '{"title":"smoke","description":"smoke do container\n\n\u27e6s:glpi-1\u27e7","state":"OPEN","severity":"LOW"}')"
ID="$(echo "$created" | sed -E 's/.*"id":"([^"]+)".*/\1/')"
[[ "$ID" =~ ^B- ]] && ok "3 POST /api/v2/records criou $ID" || fail "3 POST não devolveu id: $created"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v2/records?page=1&pageSize=10")"
[ "$code" = "200" ] && ok "3 GET /api/v2/records = 200" || fail "3 listagem devolveu $code"

# 4. dado sobrevive a restart (volume), com o marcador intacto
docker restart "$NAME" >/dev/null
wait_healthy || fail "4 container não voltou healthy após restart"
body="$(curl -fsS "$BASE/api/v2/records/$ID")"
echo "$body" | grep -q '⟦s:glpi-1⟧' && ok "4 $ID persistiu após restart com o marcador" || fail "4 $ID sumiu ou perdeu o marcador: $body"

# 5. parada rápida e limpa
t0=$(date +%s)
docker stop "$NAME" >/dev/null
elapsed=$(( $(date +%s) - t0 ))
exitcode="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$elapsed" -lt 5 ] && [ "$exitcode" = "0" ] && ok "5 docker stop em ${elapsed}s com código 0" || fail "5 docker stop levou ${elapsed}s, código $exitcode"

# 6. negativo: código somente leitura
if docker run --rm --entrypoint sh "$IMAGE" -c 'touch /app/x' >/dev/null 2>&1; then
  fail "6 usuário conseguiu gravar em /app"
else
  ok "6 /app é somente leitura para o usuário do container"
fi

echo "Smoke do Sistema B: tudo OK"
