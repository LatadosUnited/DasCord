#!/usr/bin/env bash
# Sobe o servidor na VPS: atualiza o código, compila lá e reinicia o serviço.
# Também publica uma versão nova do app desktop (--publicar).
#
# O binário é compilado NA VPS: o que o Windows gera aqui é .exe e não roda em Linux.
#
# Nenhuma senha mora aqui. A autenticação é por chave SSH; sem chave instalada, o
# ssh vai pedir a senha a cada passo. Para instalar a chave uma vez só:
#   ssh-copy-id -i ~/.ssh/dascord_vps.pub root@srv1915663.hstgr.cloud
#
# Uso:
#   ./scripts/deploy.sh                      # atualiza o servidor e reinicia
#   ./scripts/deploy.sh --publicar <arquivo> # publica o instalador (.msi) como versão nova
#   ./scripts/deploy.sh --descobrir          # mostra o que existe na VPS (não muda nada)
#
# Dá para apontar para outra máquina ou outro caminho pelo ambiente:
#   DASCORD_SSH=root@outra.maquina DASCORD_REMOTE_DIR=/srv/dascord ./scripts/deploy.sh

set -euo pipefail

SSH_TARGET="${DASCORD_SSH:-root@srv1915663.hstgr.cloud}"
SSH_KEY="${DASCORD_SSH_KEY:-$HOME/.ssh/dascord_vps}"
REMOTE_DIR="${DASCORD_REMOTE_DIR:-/opt/dascord}"
SERVICE="${DASCORD_SERVICE:-dascord-server}"
# A pasta de dados do servidor (banco, uploads e os instaladores em updates/)
REMOTE_DATA="${DASCORD_REMOTE_DATA:-$REMOTE_DIR/server/data}"

ssh_opts=(-o StrictHostKeyChecking=accept-new)
[ -f "$SSH_KEY" ] && ssh_opts+=(-i "$SSH_KEY")

remoto() { ssh "${ssh_opts[@]}" "$SSH_TARGET" "$@"; }

descobrir() {
  echo "== Serviços com 'dascord' no nome"
  remoto "systemctl list-units --type=service --all --no-pager --no-legend '*dascord*' || true"
  echo "== Pasta de trabalho do serviço $SERVICE"
  remoto "systemctl show -p WorkingDirectory --value $SERVICE 2>/dev/null || echo '(serviço não encontrado)'"
  echo "== Repositórios git em /opt, /srv e /root"
  remoto "find /opt /srv /root -maxdepth 3 -name .git -type d 2>/dev/null | sed 's:/.git$::' || true"
  echo
  echo "Se os caminhos acima forem outros, exporte DASCORD_REMOTE_DIR, DASCORD_SERVICE"
  echo "e DASCORD_REMOTE_DATA antes de rodar o deploy."
}

# Versão nova só vale depois que o instalador e a assinatura já estão lá:
# o latest.json é o último a subir, senão um app pode pedir o que ainda não chegou.
publicar() {
  local instalador="$1"
  local assinatura="$instalador.sig"
  local versao
  versao="$(node -p "require('./package.json').version")"

  [ -f "$instalador" ] || { echo "Instalador não encontrado: $instalador" >&2; exit 1; }
  [ -f "$assinatura" ] || {
    echo "Assinatura não encontrada: $assinatura" >&2
    echo "O build só assina com TAURI_SIGNING_PRIVATE_KEY definida (veja o README)." >&2
    exit 1
  }

  local nome
  nome="$(basename "$instalador")"
  case "$nome" in
    *"$versao"*) ;;
    *) echo "Aviso: o nome do instalador não bate com a versão $versao do package.json." >&2 ;;
  esac

  echo "→ Enviando $nome e a assinatura para $REMOTE_DATA/updates"
  remoto "mkdir -p '$REMOTE_DATA/updates'"
  scp "${ssh_opts[@]}" "$instalador" "$assinatura" "$SSH_TARGET:$REMOTE_DATA/updates/"

  local notas
  notas="${DASCORD_UPDATE_NOTES:-Veja o CHANGELOG da versão $versao.}"
  echo "→ Publicando o latest.json (versão $versao)"
  remoto "cat > '$REMOTE_DATA/updates/latest.json'" <<JSON
{
  "version": "$versao",
  "notes": "$notas",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "windows-x86_64": "$nome"
  }
}
JSON
  echo "✓ Versão $versao publicada. Os apps a partir de agora enxergam a atualização."
}

atualizar_servidor() {
  echo "→ Atualizando o código em $REMOTE_DIR"
  remoto "cd '$REMOTE_DIR' && git pull --ff-only"

  # Compilar antes de parar o serviço: se a compilação falhar, o que está no ar continua de pé
  echo "→ Compilando o servidor (demora alguns minutos)"
  remoto "cd '$REMOTE_DIR' && cargo build --release --manifest-path server/Cargo.toml"

  echo "→ Reiniciando $SERVICE (derruba as conexões abertas, inclusive as chamadas de voz)"
  remoto "systemctl restart '$SERVICE' && sleep 2 && systemctl is-active '$SERVICE'"

  echo "→ Conferindo a versão que respondeu"
  remoto "curl -fsS http://127.0.0.1:3001/api/version" || echo "(não respondeu em 127.0.0.1:3001)"
  echo
}

case "${1:-}" in
  --descobrir) descobrir ;;
  --publicar)
    [ $# -ge 2 ] || { echo "Uso: $0 --publicar <caminho-do-instalador>" >&2; exit 1; }
    publicar "$2"
    ;;
  "") atualizar_servidor ;;
  *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
esac
