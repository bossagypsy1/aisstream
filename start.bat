@echo off
cd /d "C:\Users\zebedee\Desktop\claud\aisstream"
"C:\Program Files\nodejs\node.exe" node_modules\tsx\dist\cli.mjs src\server.ts > server.out.log 2> server.err.log
