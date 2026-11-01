# Draft API (черновики закрытия)

Минимальный HTTP API рядом с ботом. Telegram bot token сюда не кладётся.

## Запуск

```powershell
cd api
copy .env.example .env   # если ещё нет
python server.py
```

## Эндпоинты

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/health` | без авторизации |
| POST | `/api/drafts` | сохранить черновик (Bearer) |
| GET | `/api/drafts/{point}` | последний черновик ПП |
| GET | `/api/drafts/{point}/text` | текст отчёта |

Заголовок: `Authorization: Bearer <EXTENSION_API_TOKEN>`

Последний успешный POST по `point_number` перезаписывает предыдущий. TTL по умолчанию 48 часов.
