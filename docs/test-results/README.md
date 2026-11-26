# Результаты проверок (прогон g10, 26.11.2026, HEAD 62dd612)

Реальный PostgreSQL 17, production-сборка Next.js (standalone). Стенды: production (APP_MODE=production) и demo, отдельные тестовые БД. Данные только фейковые; внешних вызовов нет (АТОЛ, SMS, MAX, почта, LLM — моки/заглушки).

| Файл | Что | Итог |
|---|---|---|
| unit.txt | модульные тесты (vitest) | 118/118 |
| db.txt | тесты на реальной БД | 67/67 |
| tsc.txt | tsc --noEmit | 0 ошибок |
| audit.txt | npm audit | 0 уязвимостей |
| backup.txt | tests/backup/roundtrip.sh | 19/19 |
| health-alert.txt | алерт по /api/health | 5/5 |
| build.txt | npm run build | ок |
| e2e.txt | сквозная цепочка (регистратор + врач) | пройдена |
| http-holes.txt, http-v2.txt | HTTP-регрессия прошлых находок | 16/16, 13/13 |
| http-v3prod.txt, http-v3demo.txt | матрица прав по ролям, поля, поиск, 2FA, метрики, CSP — production и demo | 51/51, 51/51 |
| logs.txt | строки журнала production-стенда — JSON | 1/1 (баннер Next.js не считается) |
| migrations.txt | миграции: пустая БД и копия БД v2 | 13/13; строки совпали; diff схемы пуст |
| readonly-root-server.txt | сервер с корнем ФС только для чтения (bwrap) | v3 47/47 (до добавления 4 новых тестов) |
| csp-browser-check.json, csp-xss-vectors.json | headless Chrome: все вкладки 5 ролей, prod и demo | 0 нарушений CSP; XSS-векторы заблокированы |

В migrations.txt ошибка «relation "Document" does not exist» — опечатка в имени таблицы в самом скрипте проверки (такой таблицы нет). На результат она не влияет.

**Не проверено запуском, нет Docker:** docker build, docker compose up, e2e на образе, бэкап и восстановление в контейнерах.
