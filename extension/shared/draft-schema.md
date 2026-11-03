# JSON-черновик закрытия

```json
{
  "point_number": "1125",
  "source": "turbo-pvz",
  "collected_at": "2026-10-31T18:30:00+03:00",
  "closing": {
    "transport_number": "6539436",
    "transport_date": "31.10.2026",
    "closing_time": "18:23",
    "accepted_total": 801,
    "tya": 18,
    "ktya": 4,
    "shortage": 1,
    "excess": 3,
    "zasyl": 3,
    "issued": 721,
    "leftover": 1527
  },
  "meta": {
    "carriage_long_id": "...",
    "pages": ["giveout", "remains", "tare", "carriages", "zasyl"],
    "warnings": [],
    "checklist": {}
  }
}
```

Целевой текст в боте:

```
ПП-{point_number}

Закрыли перевозку #{transport_number} от {transport_date}.

Закрыли перевозку в {closing_time}

Принято всего: {accepted_total} ед.

1) ТЯ: {tya}
2) КТЯ: {ktya}
3) Недостачи: {shortage}
4) Излишки: {excess}
5) Засылы: {zasyl}

Выдано: {issued} ед.

Остатки на складе: {leftover} ед.

ПП - закрыто.
```
