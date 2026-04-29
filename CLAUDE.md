<!-- BEGIN LOCAL PM2 DEV SERVER POLICY -->

# Local dev server policy

This repo's dev server is managed by PM2 from the parent workspace.

Parent workspace:

```text
C:\Users\zebedee\Desktop\claud
```

PM2 ecosystem file:

```text
C:\Users\zebedee\Desktop\claud\ecosystem.config.js
```

PM2 app name for this repo:

```text
aisstream
```

## Required commands

Check status:

```powershell
pm2 status aisstream
```

View logs:

```powershell
pm2 logs aisstream --lines 120
```

Restart after code changes:

```powershell
pm2 restart aisstream
```

Start if missing:

```powershell
pm2 start "C:\Users\zebedee\Desktop\claud\ecosystem.config.js" --only aisstream
```

Stop:

```powershell
pm2 stop aisstream
```

## Strict rules

Do not start this repo's dev server directly with:

- npm run dev
- pnpm dev
- yarn dev
- next dev
- vite
- node server start commands
- Start-Process
- cmd /c start
- bash background commands
- wsl background commands

Use PM2 only.

Do not kill processes by name. Never run broad commands such as:

```powershell
Stop-Process -Name node -Force
taskkill /F /IM node.exe /T
Stop-Process -Name powershell -Force
taskkill /F /IM cmd.exe /T
```

Only stop or restart the named PM2 app for this repo.

If `pm2 status aisstream` does not show the app, report that PM2 is not managing it. Do not improvise by launching a raw server.

Connection failures do not automatically mean a port clash. Check PM2 status and logs before taking action.

<!-- END LOCAL PM2 DEV SERVER POLICY -->


