#!/usr/bin/env bash
# Prepara a VM de produção do zero (S4.3, ADR-010). Idempotente: pode rodar de novo sem estragar nada.
#   scp -i ~/.ssh/cybercorp-vm infra/scripts/bootstrap-vm.sh ubuntu@<IP>:/tmp/
#   ssh -i ~/.ssh/cybercorp-vm ubuntu@<IP> 'sudo bash /tmp/bootstrap-vm.sh "<chave pública do deploy>"'
# Testado em Ubuntu 24.04 (ARM Ampere A1 da Oracle Always Free).
set -euo pipefail

DEPLOY_USER=deploy
APP_DIR=/opt/cybercorp
SWAP_FILE=/swapfile
DEPLOY_PUBKEY="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "rode como root (sudo bash $0)" >&2
  exit 1
fi

echo "== Docker Engine + plugin compose (repositório oficial)"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "== Usuário ${DEPLOY_USER} (deploy sem root, no grupo docker)"
id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
AUTH_KEYS="/home/${DEPLOY_USER}/.ssh/authorized_keys"
touch "$AUTH_KEYS"
if [ -n "$DEPLOY_PUBKEY" ] && ! grep -qF "$DEPLOY_PUBKEY" "$AUTH_KEYS"; then
  echo "$DEPLOY_PUBKEY" >> "$AUTH_KEYS"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

echo "== Firewall da imagem Ubuntu da Oracle: libera 80 e 443 (sem isso o Let's Encrypt não emite)"
# A imagem vem com iptables bloqueando tudo menos a 22. As regras entram antes do REJECT e são persistidas
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    reject_at=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$reject_at" ]; then
      iptables -I INPUT "$reject_at" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
else
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  netfilter-persistent save
fi

echo "== Swap de 2 GB (folga para o build e para a VM Micro do plano B)"
if ! swapon --show | grep -q "$SWAP_FILE"; then
  [ -f "$SWAP_FILE" ] || fallocate -l 2G "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  swapon "$SWAP_FILE"
  grep -q "$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
fi

echo "== Diretório da aplicação: ${APP_DIR} (o deploy copia o compose e o Caddyfile para cá)"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/infra" "$APP_DIR/infra/caddy"
if [ ! -f "$APP_DIR/.env" ]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$APP_DIR/.env"
  echo "   ${APP_DIR}/.env criado vazio: preencha a partir de infra/.env.production.example"
fi

echo
echo "Pronto. Docker $(docker --version | awk '{print $3}' | tr -d ,) · compose $(docker compose version --short)"
echo "Próximos passos: preencher ${APP_DIR}/.env e rodar o workflow deploy-prod (ou o primeiro deploy manual do infra/README)."
