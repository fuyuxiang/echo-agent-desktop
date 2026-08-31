#!/usr/bin/env bash
# Install the EchoAgent desktop updater static server on 10.132.19.82.
set -euo pipefail

NGINX_SITE="/etc/nginx/sites-enabled/echo-agent-server-https"
NGINX_SNIPPET="/etc/nginx/snippets/echoagent-desktop-updates.conf"
PUBLISHER="/usr/local/sbin/echoagent-publish-update"
UPDATE_ROOT="/opt/echo-agent-desktop-updates"
BACKUP_DIR="/etc/nginx/echoagent-backups"
INCLUDE_LINE="    include /etc/nginx/snippets/echoagent-desktop-updates.conf;"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "This installer must run as root." >&2
  exit 1
fi
if [[ ! -f /tmp/echoagent-publish-update || ! -f /tmp/echoagent-desktop-updates-nginx.conf ]]; then
  echo "Upload the publisher and Nginx snippet to /tmp before running this installer." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$UPDATE_ROOT/stable" "$UPDATE_ROOT/releases"
install -o root -g root -m 0755 /tmp/echoagent-publish-update "$PUBLISHER"
install -o root -g root -m 0644 /tmp/echoagent-desktop-updates-nginx.conf "$NGINX_SNIPPET"

BACKUP=""
if ! grep -Fq "$INCLUDE_LINE" "$NGINX_SITE"; then
  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/echo-agent-server-https.$(date +%Y%m%d%H%M%S)"
  cp -p "$NGINX_SITE" "$BACKUP"
  sed -i "\|^[[:space:]]*location / {|i\\$INCLUDE_LINE" "$NGINX_SITE"
fi

if ! nginx -t; then
  if [[ -n "$BACKUP" ]]; then
    cp -p "$BACKUP" "$NGINX_SITE"
    nginx -t
  fi
  echo "Nginx validation failed; restored the previous site configuration." >&2
  exit 1
fi

systemctl reload nginx
echo "EchoAgent desktop update server installed."
echo "Root: $UPDATE_ROOT"
