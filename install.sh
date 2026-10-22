#!/bin/bash
set -euo pipefail
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; N='\033[0m'
ok() { echo -e "${G}✓ $*${N}"; }
step() { echo -e "\n${Y}▶ $*${N}"; }
die() { echo -e "${R}✗ $*${N}"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "با root اجرا کنید: sudo bash $0"

PORT="${PORT:-3200}"
DATA_DIR="/var/lib/batman-license"
APP_DIR="/opt/batman-license"
SERVICE="batman-license"

step "بررسی سیستم"
command -v apt-get >/dev/null || die "فقط Ubuntu/Debian"
ok "$(. /etc/os-release; echo $PRETTY_NAME)"

step "نصب Node.js (در صورت نیاز)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "Node $(node -v)"

step "کپی فایل‌ها"
mkdir -p "$APP_DIR" "$DATA_DIR"
cp -a server.js cli.js package.json "$APP_DIR/"
cp -a public lib "$APP_DIR/"
chmod 700 "$DATA_DIR"
ok "فایل‌ها در $APP_DIR"

step "راه‌اندازی ادمین"
if [ ! -f "$DATA_DIR/db.json" ] || ! grep -q '"passHash": "[^"]' "$DATA_DIR/db.json" 2>/dev/null; then
  echo "لطفاً نام کاربری و رمز ادمین را وارد کنید:"
  DATA_DIR="$DATA_DIR" node "$APP_DIR/cli.js" init
else
  ok "ادمین از قبل وجود دارد"
fi

step "سرویس systemd"
cat > /etc/systemd/system/${SERVICE}.service << EOF
[Unit]
Description=Batman License Manager
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=HOST=0.0.0.0
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE"
ok "سرویس $SERVICE فعال شد"

# firewall
if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT"/tcp comment "Batman License" 2>/dev/null || true
fi

IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || curl -s --max-time 3 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "=============================================="
echo -e "${G}نصب پنل مدیریت لایسنس تمام شد${N}"
echo "آدرس:  http://${IP}:${PORT}"
echo "پورت:  $PORT"
echo "دیتابیس: $DATA_DIR/db.json"
echo ""
echo "دستورات:"
echo "  systemctl status $SERVICE"
echo "  journalctl -u $SERVICE -f"
echo "  systemctl restart $SERVICE"
echo "=============================================="
