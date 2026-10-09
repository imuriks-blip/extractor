# EXT-87 такт 3 — живая проба замера (09.10.2026)

Тестовый экземпляр: копия server.mjs + junction на lib рабочей копии (b1d2430), порт 4391, своя временная папка данных, пульт включён (words/bell/toasts выключены), процесс node без окна (windowsHide), pid 28456. Запросы — только на 4391.

Запусков claude.exe: 1 (второе нажатие через 30 с ответило reused без запуска).

POST /api/act {action:"measure", intentId} как делает страница (токен из meta GET /, Origin, Sec-Fetch-Site: same-origin) → 200, outcome ok, 5,6 с:
"5 ч: 7 % · сброс 04:00 · 7 дн: 38 % · замер 23:58".

Внешние следы:
- событие лимита пришло 2026-10-09T20:58:37.605Z (23:58:37 местного); last.json, log.jsonl, last-stream.jsonl, settings.json записаны в measure/ папки данных экземпляра.
- GET /api/usage: remaining {source:"measure", ageSec:10, ageKind:"exact", fiveHour 0.07 fresh:true, sevenDay 0.38 fresh:true}; measures.today {count:1, costUsd:0.027612, tokens:13517}; measuring:false.
- reused: второй POST → 200, "замер был в 23:58: …", reused:true; строк в log.jsonl по-прежнему 1.
- хуки: hook_started в потоке — 0; очередь pending/ (2026-10-09.md, 10052 байта, 22:50:13) до и после идентична; bell.log живой витрины 320 строк до и после.
- папка сессии замера: в журналах Claude её нет вовсе (--no-session-persistence); в /api/ceh и /api/usage ни имени папки, ни session_id замера.
- процессов claude после замера: дочерних у pid 28456 — только git.exe (опрос самой витрины); claude.exe по цепочке ParentProcessId от 28456 нет (остальные claude.exe в системе — чужие, не тронуты).

Цена: total_cost_usd 0.027612; токены input 10, output 154 (thinking 147), cache_creation 13353, cache_read 0 (всего 13517). Модель claude-haiku-4-5-20251001. С --setting-sources project цена та же ≈0,027 $, что и без него — флаг на цену не повлиял (основной объём — создание кэша системного запроса 13,3 тыс. токенов).

Остановка: taskkill /T /F /PID 28456 (по запомненному pid), процесс ушёл; временная папка данных удалена (unlinkSync/rmdirSync).
