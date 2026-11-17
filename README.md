# Fitbit Health Hub: Google Health ↔ Google Sheets ↔ OAuth MCP

Подготовленная безопасная версия для личного использования. По умолчанию SYNC_ENABLED=false. Эта ветка сама по себе не подтверждает развертывание или успешную синхронизацию.

- Health → Sheets: активность и сон за окно до 7 дней, upsert по дате/идентификатору.
- Sheets → Health: только одобренные команды веса, процента жира и воды.
- ChatGPT: защищённый OAuth MCP для чтения и запуска sync_sheets; создание команд через Google Drive.
- Без фона, прямой записи из MCP и удаления медицинских записей.
- State/CSRF: случайный state, browser-bound cookie, одноразовый SQLite Durable Object, PKCE S256 и точный allowlist клиентских callback URI.
- Токены не попадают в Sheets, публичный репозиторий или plaintext-кеш KV.
- Журнал команд переживает сбои; неоднозначные POST не повторяются автоматически.

**Пошаговая настройка, ограничения и смысл статусов:** [docs/HEALTH_HUB.md](docs/HEALTH_HUB.md).

Не проходите согласие Google на исходном развертывании до установки и проверки защищённой версии. Google Drive connector в чате и разрешения Worker — отдельные подключения.

Существующие документы исходного проекта в docs/ описывают первоначальную версию и не заменяют инструкцию HEALTH_HUB.md для этой ветки. В частности, перечисленные там прямые log_* и delete_log из MCP здесь отключены.

## Проверка

~~~sh
npm ci
npm test
npm run check:build
node test/runtime-smoke.mjs
~~~

Существующий OAUTH_KV сохраняется. Новая SQLite Durable Object binding SYNC_STATE и миграция заданы в wrangler.jsonc. Секреты и персональные параметры вводятся непосредственно в Cloudflare, не в код или чат.

Лицензия MIT; основано на deslabpro-max/fitbit-google-health-mcp.

