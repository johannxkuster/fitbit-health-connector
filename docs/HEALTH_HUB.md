# Fitbit Health Hub — подключение по одному шагу

## Текущее состояние этой ветки

Это подготовленная версия, не подтверждение развертывания. Синхронизация выключена по умолчанию (SYNC_ENABLED=false). Живой Worker из main до слияния остаётся исходным MCP-сервером без Sheets.

Первая версия: Google Health → Daily (активность и сон) и Records (сессии сна), Sheets Commands → Google Health (только log_weight, log_body_fat, log_water). Из ChatGPT команды создаются через подключённый Google Drive, затем вызывается sync_sheets. Произвольное редактирование сенсорных данных, удаление и остальные ручные логи отключены. Это обмен данными и журналами, не полное зеркало Health: удаления из источника не удаляют исторические строки Records.

Запуск только по запросу через OAuth MCP; cron и фоновая синхронизация не включены. Пример запроса sync_sheets: start_date/end_date (максимум 7 суток); process_commands=false для первого чтения. true включает отправку одобренных команд.

## Последовательность

1. Пользователь входит в Google Cloud Console под аккаунтом Fitbit. Остановиться, если нужен вход.
2. Создать или выбрать отдельный проект. Включить Google Health API и Google Sheets API. Настроить OAuth consent screen, добавить владельца в Test users. Не публиковать таблицу.
3. Создать OAuth client типа Web application. Единственный Google redirect URI: PUBLIC_ORIGIN + /callback, где PUBLIC_ORIGIN — точный HTTPS origin Worker без завершающего слеша.
4. Пользователь вводит GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET непосредственно в Cloudflare → Worker → Settings → Variables and Secrets. Не передавать секреты в чат, Sheets, issue, PR или git.
5. В Cloudflare задать PUBLIC_ORIGIN, SPREADSHEET_ID и ALLOWED_GOOGLE_EMAIL (точный email владельца, вводить в Cloudflare). В этой ветке нет персональных значений этих параметров.
6. В интерфейсе настройки собственного MCP ChatGPT получить точный redirect URI этого подключения. Не угадывать URL, не добавлять wildcard. ALLOWED_REDIRECT_URIS — JSON-массив точных разрешённых HTTPS URI. Если ChatGPT не показывает URI, сначала исследовать интерфейс/официальную документацию и остановиться до получения точного значения. Сервер использует DCR; CIMD здесь не включён.
7. Проверить PR, развернуть проверенную ветку с SQLite Durable Object SYNC_STATE и миграцией sync-state-v1. Существующий OAUTH_KV сохранить. В deployment сначала SYNC_ENABLED=false. Убедиться, что /callback с поддельным state отклоняется, /mcp без Bearer возвращает 401, а старые гранты отклоняются.
8. Подключить /mcp из ChatGPT через OAuth. Пользователь проверяет клиента и точный URI на экране Worker, затем сам проходит вход/согласие Google. На этом экране агент останавливается. Таблица и Health до этого не заполняются.
9. После успешного OAuth и проверки owner-only доступа включить SYNC_ENABLED=true в Cloudflare, вызвать sync_sheets за один день с process_commands=false. Проверить Daily/Records/Sync_Log и отсутствие токенов.
10. Только после этого пользователь вводит одну собственную реальную команду в Commands, ставит approved=TRUE и явно просит отправку. Повторить запуск с тем же command_id: второй Health POST не должен отправиться. Не создавать тестовые фиктивные медицинские записи.

Google Drive connector в чате и OAuth Worker — отдельные подключения. Доступ этого чата к таблице сам по себе не даёт Worker доступ к Sheets или Health. Развёрнутую версию, OAuth-согласие и успешный обмен проверять по отдельности.

## Команды и подтверждение результата

Commands: command_id (8–100 символов A–Z, a–z, 0–9, _ и -), tool, arguments_json, approved (настоящий checkbox TRUE), далее серверная проекция status, attempts, operation, error_code, updated_at, payload_hash.

- log_weight: weight_kg (0 < x <= 500), datetime.
- log_body_fat: percentage (0 < x < 100), datetime.
- log_water: volume_ml (0 < x <= 10000), datetime.
- datetime обязательно с явным Z или UTC offset; значения JSON числовые, дополнительные поля запрещены.
- Не хранить секреты в аргументах. Пример только структуры, не команда к отправке: {"weight_kg":80,"datetime":"2026-11-06T10:00:00+03:00"}.
- Новый command_id — новая намеренная запись. Для повторного запуска сохранять ID и аргументы. Исправлять уже отправленную команду другим содержимым нельзя: CONFLICT.
- SUCCEEDED: Google вернул done с созданной точкой.
- ACCEPTED: Google вернул асинхронную операцию; это не подтверждение появления записи. Автоматического polling в первой версии нет, проверить запись в Fitbit.
- NEEDS_REVIEW: запрос мог быть принят до обрыва ответа/процесса. Автоповтор запрещён. Проверить Fitbit; новый ID создавать только после выяснения результата.
- REJECTED: невалидный ввод, отправки не было.
- Лимит новых отправок — 10 за запуск. Серверный журнал Durable Object — источник статуса; редактирование статуса в Sheets не сбрасывает защиту.
- Не сортировать и не редактировать служебные вкладки во время RUNNING. Если строка изменилась, сервер пытается найти её по ID и точным аргументам; следующий запуск восстанавливает проекцию.
- Не удалять SYNC_STATE: потеря журнала снимает защиту от повторной отправки старых ID. Перед сбросом/переносом необходимо отключить отправку и вывести старую очередь из использования.

Health create не документирует requestId: обещать exactly-once нельзя. Используется durable reservation до POST и отсутствие автоматического повтора при любом неопределённом результате. Разные ID с одинаковыми данными считаются разными намеренными командами.

## Приватность и ограничения

- Токены Google только в зашифрованных props гранта OAuthProvider; access token для запроса — только в памяти. Прежний plaintext KV-кеш gat: удалён из кода.
- В SYNC_STATE хранятся одноразовый OAuth flow (до 10 минут) и хеши/статусы команд, не токены или payload здоровья. Google PKCE verifier временно хранится как часть flow.
- OAuth state случайный, браузерная cookie __Host-... Secure/HttpOnly/SameSite=Lax, однократное атомарное потребление в SQLite DO. Согласие клиента с проверкой Origin; точный allowlist redirect URI; upstream и downstream PKCE S256.
- Google identity проверяется через HTTPS UserInfo; требуется verified email владельца. Старые гранты authVersion!=2 не допускаются.
- Широкий Google scope spreadsheets нужен для уже созданной таблицы; приложение ограничивает запросы фиксированным SPREADSHEET_ID. Google scope сам по себе не ограничен этой таблицей — это нужно проверить на consent screen.
- Редакторы таблицы смогут инициировать ручные записи через approved; давать права редактора только доверенным пользователям.
- Таблицы — до 1000 строк каждая; схема заголовков проверяется до обмена, при переполнении возвращается ошибка вместо скрытого усечения.
- Необработанная ошибка Google не попадает в таблицу/MCP. Sheets пишет RAW, чтобы данные не интерпретировались как формулы. Observability Worker отключена; внешние настройки Cloudflare request logs отдельно не проверены.
- Нет фона, автоматического refresh без MCP клиента, polling операций, удаления, многопользовательского режима и полного экспорта всех типов Health. Расширять после первого живого чтения.
- OAuth-токены приложений Google в режиме Testing могут требовать повторной авторизации; не переводить приложение в production автоматически.

## Проверки

npm ci
npm test
npm run check:build
node test/runtime-smoke.mjs

35 тестов: существующие преобразования Health, подмена/повтор OAuth, CSRF, owner-only, отсутствие прямых write tools, очередь, конфликт ID, неизвестный результат и потеря ответа Sheets, RAW, блокировка параллельного запуска. Smoke запускает Worker локально через miniflare/workerd, проверяет SQLite state и 401 для анонимного MCP. Использует miniflare из зависимости wrangler; поддерживает convertV4MiniflareOptions для Miniflare 5.

На 2026-11-06: тесты и локальная сборка прошли. Живой OAuth, доступ Worker к Google Sheets/Health, deployment и ChatGPT Business end-to-end ещё не проверены.

## Официальные источники

- Google Health create: https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/create
- Google UserInfo/OIDC: https://developers.google.com/identity/openid-connect/reference
- Cloudflare OAuth security: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- Точный callback ChatGPT: https://developers.openai.com/plugins/build/auth
