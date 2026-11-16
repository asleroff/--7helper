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
    "not_accepted": 331,
    "tya": 18,
    "ktya": 4,
    "shortage": 1,
    "excess": 3,
    "zasyl": 3,
    "issued": 721,
    "leftover": 1527,
    "ozon_shelf": 40
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
ПП_{point_number}

Перевозку закрыли
Принято: {accepted_total}
Не принято: {not_accepted}
Выдано: {issued}
Остаток: {leftover}
Остаток полка: {ozon_shelf}
Машина была в {closing_time}
ПП закрыто
```

Строка «Остаток полка» не пишется, если на пункте нет Озон полки.
