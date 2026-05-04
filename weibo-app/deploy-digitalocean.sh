#!/usr/bin/env bash
set -euo pipefail

# One-shot bootstrap + deploy script for Ubuntu on DigitalOcean.
# What it does:
# 1) Installs system deps, Node LTS, PM2, Nginx, Certbot
# 2) Clones/pulls your repo
# 3) Installs backend/frontend deps
# 4) Writes backend/frontend production env files
# 5) Installs Playwright runtime deps (needed for cookie refresh flows)
# 6) Builds frontend, starts backend with PM2
# 7) Configures Nginx reverse proxy + static hosting
# 8) Enables HTTPS with Let's Encrypt

# =========================
# Required configuration
# =========================
REPO_URL="https://github.com/opedium/WeiboClient.git"
# Optional when deploying without DNS: leave empty to serve by server IP (HTTP only).
DOMAIN=""
EMAIL=""
# Set false only after DOMAIN + EMAIL are configured and DNS points to your droplet.
SKIP_TLS="true"

# Optional configuration
APP_DIR="/opt/weibo-client"
BACKEND_PORT="3001"
JSON_LIMIT="256kb"
UPLOAD_MAX_BYTES="10485760"
COOKIE_REFRESH_MODE="headless"

# Set MongoDB URI for MongoDB mode.
# Leave empty to use file-based fallback storage.
MONGODB_URI=""
MONGODB_DB="weibo_app"
MONGODB_COLLECTION="copywriting"
MONGODB_ACCOUNTS_COLLECTION="accounts"
MONGODB_SCHEDULES_COLLECTION="schedules"

# Security settings
AUTH_REQUIRED="true"
AUTH_TOKEN=""
COOKIE_SECRET=""

# CORS allowlist (your production origins)
# If empty, script auto-sets:
# - DOMAIN set: https://DOMAIN,https://www.DOMAIN
# - DOMAIN empty: *
CORS_ORIGINS=""

# =========================
# Preflight checks
# =========================
if [[ "${REPO_URL}" == *"YOUR_GITHUB_USERNAME"* ]]; then
  echo "[ERROR] Please set REPO_URL at the top of this script."
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "[INFO] Please run as root: sudo bash deploy-digitalocean.sh"
  exit 1
fi

DEPLOY_USER="${SUDO_USER:-root}"
DEPLOY_HOME="/root"
if id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  DEPLOY_HOME="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
fi

echo "[1/10] Installing system packages..."
apt update
apt install -y ca-certificates curl gnupg git nginx ufw certbot python3-certbot-nginx openssl

echo "[2/10] Installing Node.js LTS + PM2..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt install -y nodejs
fi
npm install -g pm2

if [[ -z "${AUTH_TOKEN}" ]]; then
  AUTH_TOKEN="$(openssl rand -hex 24)"
fi
if [[ -z "${COOKIE_SECRET}" ]]; then
  COOKIE_SECRET="$(openssl rand -hex 32)"
fi
if [[ -z "${CORS_ORIGINS}" ]]; then
  if [[ -n "${DOMAIN}" ]]; then
    CORS_ORIGINS="https://${DOMAIN},https://www.${DOMAIN}"
  else
    CORS_ORIGINS="*"
  fi
fi

echo "[3/10] Cloning/updating repository..."
mkdir -p "${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch --all
  git -C "${APP_DIR}" reset --hard origin/$(git -C "${APP_DIR}" rev-parse --abbrev-ref HEAD || echo main)
else
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi

echo "[4/10] Installing backend dependencies..."
cd "${APP_DIR}/weibo-app/backend"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "[5/10] Writing backend .env..."
cat > .env <<EOF
PORT=${BACKEND_PORT}
JSON_LIMIT=${JSON_LIMIT}
UPLOAD_MAX_BYTES=${UPLOAD_MAX_BYTES}
CORS_ORIGINS=${CORS_ORIGINS}

AUTH_REQUIRED=${AUTH_REQUIRED}
AUTH_TOKEN=${AUTH_TOKEN}

MONGODB_URI=${MONGODB_URI}
MONGODB_DB=${MONGODB_DB}
MONGODB_COLLECTION=${MONGODB_COLLECTION}
MONGODB_ACCOUNTS_COLLECTION=${MONGODB_ACCOUNTS_COLLECTION}
MONGODB_SCHEDULES_COLLECTION=${MONGODB_SCHEDULES_COLLECTION}

COOKIE_SECRET=${COOKIE_SECRET}
COOKIE_REFRESH_MODE=${COOKIE_REFRESH_MODE}
EOF

if [[ -z "${MONGODB_URI}" ]]; then
  echo "[WARN] MONGODB_URI is empty -> backend will use local file storage fallback."
fi

echo "[6/10] Installing Playwright runtime + Linux deps..."
npx playwright install chromium
npx playwright install-deps

echo "[7/10] Installing frontend deps and building..."
cd "${APP_DIR}/weibo-app/frontend"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
cat > .env.production <<EOF
VITE_API_URL=
VITE_API_TIMEOUT_MS=90000
EOF
npm run build

echo "[8/10] Configuring Nginx site..."
NGINX_SERVER_NAME="_"
if [[ -n "${DOMAIN}" ]]; then
  NGINX_SERVER_NAME="${DOMAIN} www.${DOMAIN}"
fi

cat > /etc/nginx/sites-available/weibo-client <<EOF
server {
    listen 80;
    server_name ${NGINX_SERVER_NAME};

    root ${APP_DIR}/weibo-app/frontend/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/weibo-client /etc/nginx/sites-enabled/weibo-client
nginx -t
systemctl restart nginx

echo "[9/10] Starting backend with PM2..."
cd "${APP_DIR}/weibo-app/backend"
pm2 delete weibo-backend >/dev/null 2>&1 || true
pm2 start server.js --name weibo-backend
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null
systemctl enable pm2-root
systemctl restart pm2-root

echo "[10/10] Enabling firewall and HTTPS..."
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable

if [[ "${SKIP_TLS}" == "true" || -z "${DOMAIN}" || -z "${EMAIL}" ]]; then
  echo "[WARN] TLS step skipped. Running HTTP only."
  echo "[WARN] To enable HTTPS later, set DOMAIN + EMAIL and SKIP_TLS=false, then run certbot manually."
else
  certbot --nginx --non-interactive --agree-tos --redirect -m "${EMAIL}" -d "${DOMAIN}" -d "www.${DOMAIN}" || {
    echo "[WARN] Certbot failed. Check DNS A records and retry:";
    echo "       certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}";
  }
fi

SERVER_IP="$(hostname -I | awk '{print $1}')"

echo
echo "===== Deployment complete ====="
if [[ -n "${DOMAIN}" && "${SKIP_TLS}" != "true" ]]; then
  echo "Domain: https://${DOMAIN}"
  echo "Backend health: https://${DOMAIN}/api/health"
elif [[ -n "${DOMAIN}" ]]; then
  echo "Domain (HTTP): http://${DOMAIN}"
  echo "Backend health: http://${DOMAIN}/api/health"
else
  echo "Server IP (HTTP): http://${SERVER_IP}"
  echo "Backend health: http://${SERVER_IP}/api/health"
fi
echo "Auth token (save this securely): ${AUTH_TOKEN}"
echo "COOKIE_SECRET: ${COOKIE_SECRET}"
echo

echo "Useful commands:"
echo "  pm2 status"
echo "  pm2 logs weibo-backend"
echo "  systemctl status nginx"
if [[ -n "${DOMAIN}" && "${SKIP_TLS}" != "true" ]]; then
  echo "  curl -s https://${DOMAIN}/api/health"
elif [[ -n "${DOMAIN}" ]]; then
  echo "  curl -s http://${DOMAIN}/api/health"
else
  echo "  curl -s http://${SERVER_IP}/api/health"
fi
