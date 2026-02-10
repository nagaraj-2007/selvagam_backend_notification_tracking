# Deploy to Hostinger - Quick Guide

## Step 1: Upload Files
1. Zip the `backend_server` folder
2. Login to Hostinger File Manager
3. Upload to `/home/your-username/` or `/var/www/`
4. Extract the zip

## Step 2: SSH and Install
```bash
ssh your-username@your-server-ip
cd /home/your-username/backend_server
npm install
```

## Step 3: Start Server
```bash
npm install -g pm2
pm2 start server.js --name bus-tracking
pm2 save
pm2 startup
```

## Step 4: Check Status
```bash
pm2 status
curl http://localhost:3000/health
```

## Step 5: Update Driver App
Change backend URL in Flutter app:
```dart
// lib/services/api_service.dart
static const String _backendUrl = 'http://your-hostinger-domain.com';
```

## Useful Commands
```bash
pm2 logs bus-tracking    # View logs
pm2 restart bus-tracking # Restart
pm2 stop bus-tracking    # Stop
```

## Test Notification Flow
1. Start trip in driver app
2. Drive near a stop (within 50m)
3. Parents receive automatic notifications
