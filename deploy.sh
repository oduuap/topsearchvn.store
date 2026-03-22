#!/bin/bash
# Script chạy trên VPS sau khi upload files xong
# Chạy: bash deploy.sh

APP_DIR="/var/www/topsearchvn.store"

echo "=== Cài Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== Cài PM2 ==="
sudo npm install -g pm2

echo "=== Cài Chromium (cho crawl) ==="
sudo apt install -y chromium-browser

echo "=== Cài dependencies ==="
cd $APP_DIR
npm install --omit=dev

echo "=== Khởi động app với PM2 ==="
pm2 stop topsearchvn 2>/dev/null || true
pm2 start server.js --name topsearchvn
pm2 save
pm2 startup | tail -1 | bash

echo "=== Cấu hình Apache ==="
sudo a2enmod proxy proxy_http
sudo cp topsearchvn.conf /etc/apache2/sites-available/topsearchvn.conf
sudo a2ensite topsearchvn
sudo a2dissite 000-default 2>/dev/null || true
sudo systemctl reload apache2

echo ""
echo "=== XONG! Truy cập: http://topsearchvn.store ==="
echo "=== Xem log: pm2 logs topsearchvn ==="
