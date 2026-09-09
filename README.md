# Digital goods core — stage 2

Backend маркетплейса цифровых товаров: мультипозиционные заказы, частичные возвраты,
защита от недобросовестного поставщика, долговечная очередь с rate limit и
append-only история заказов и денег.

Решение второго этапа построено поверх первого. Старый формат создания заказа
`{ "sku": "..." }` сохранён, новый формат принимает массив `items`.

Полный контракт: [docs/openapi.yaml](docs/openapi.yaml).

## Запуск

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run seed
npm run dev
```

Либо API и PostgreSQL целиком в Docker:

```bash
docker compose up --build
```

## Основной сценарий

Создать заказ из товаров двух поставщиков:

```bash
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{
    "idempotency_key":"order-001",
    "items":[
      {"sku":"STEAM-TOPUP-500"},
      {"sku":"KEY-GTA5"}
    ]
  }'
```

Сумма заказа равна `2490 RUB`. Эмулировать оплату:

```bash
curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"payment-001",
    "order_id":"order-001",
    "status":"paid",
    "amount":2490,
    "currency":"RUB",
    "created_at":"2026-01-01T12:00:00Z"
  }'

curl -s localhost:3000/orders/order-001
```

Каждый элемент ответа имеет собственные `status`, `provider` и `delivery_code`.
Раздел `money` показывает инвариант:

```text
paid = delivered + refunded + pending
```

Для завершённого заказа `pending = 0`, а значит
`paid = delivered + refunded` и `balanced = true`.

## Частичная выдача и возврат

Сделать поставщика B недоступным и создать заказ из товаров A и B:

```bash
curl -s -X POST localhost:3000/admin/providers/B/config \
  -H 'content-type: application/json' \
  -d '{"failRate":1,"reset":true}'

curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{
    "idempotency_key":"partial-001",
    "items":[
      {"sku":"STEAM-TOPUP-500"},
      {"sku":"KEY-GTA5"}
    ]
  }'

curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{
    "event_id":"payment-partial-001",
    "order_id":"partial-001",
    "status":"paid",
    "amount":2490,
    "currency":"RUB",
    "created_at":"2026-01-01T12:01:00Z"
  }'
```

После пяти безопасных попыток позиция B будет возвращена, а позиция A останется
выданной. Проверить результат:

```bash
curl -s localhost:3000/orders/partial-001
curl -s localhost:3000/admin/reconciliation
```

Ожидаемая сверка: `2490 = 500 delivered + 1990 refunded`, `balanced: true`.
Повторный `POST /admin/recover` не создаёт новый код или возврат благодаря
уникальным idempotency key.

Вернуть честное поведение заглушки:

```bash
curl -s -X POST localhost:3000/admin/providers/B/config \
  -H 'content-type: application/json' \
  -d '{"reset":true}'
```

## Недобросовестный поставщик

Детерминированные переключатели действуют на один следующий запрос:

- `duplicateNext` — вернуть уже выданный код;
- `wrongSkuNext` — выдать код от чужого SKU;
- `errorAfterIssueNext` — сохранить выдачу, но ответить ошибкой.

Есть также вероятностные варианты `duplicateRate`, `wrongSkuRate` и
`errorAfterIssueRate` со значениями от `0` до `1`.

Пример «выдал, но ответил ошибкой»:

```bash
curl -s -X POST localhost:3000/admin/providers/A/config \
  -H 'content-type: application/json' \
  -d '{"errorAfterIssueNext":true}'
```

После создания и оплаты товара поставщика A приложение проверит результат через
запрос состояния с тем же `request_id` и сохранит ровно один код. Повторной
выдачи не будет.

Пример дубля: сначала выдайте любой товар A, затем включите сценарий:

```bash
curl -s -X POST localhost:3000/admin/providers/A/config \
  -H 'content-type: application/json' \
  -d '{"duplicateNext":true}'
```

Дубликат не попадёт покупателю: ограничение `issued_codes(code) PRIMARY KEY`
отклонит его, расхождение появится в `GET /admin/reconciliation`, а worker
автоматически запросит замену с новой версией request id.

## Очередь и лимит поставщика

Настроить поставщику A один запрос на пятисекундное окно:

```bash
curl -s -X POST localhost:3000/admin/providers/A/config \
  -H 'content-type: application/json' \
  -d '{"limitPerWindow":1,"windowMs":5000,"reset":true}'
```

Токен лимита резервируется транзакционно в PostgreSQL до обращения к поставщику.
Несколько worker-процессов используют `FOR UPDATE SKIP LOCKED`, поэтому один job
не исполняется одновременно, а общий лимит не превышается. Оплаченные позиции
получают приоритет `100`; неоплаченные остаются в `waiting_payment` и не тратят
лимит.

Прогресс:

```bash
curl -s localhost:3000/admin/queue
```

## Восстановление и история

Worker запускается вместе с API. Просроченная lease означает аварийно прерванную
работу: позиция возвращается в очередь и повторяет тот же `request_id`. Ручной
запуск того же безопасного механизма:

```bash
curl -s -X POST localhost:3000/admin/recover
```

Состояние заказа на момент времени восстанавливается воспроизведением событий:

```bash
curl -s 'localhost:3000/orders/order-001/history?at=2026-01-01T12:00:30.000Z'
```

Итоги ledger за период:

```bash
curl -s 'localhost:3000/admin/ledger?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z'
```

`money_ledger` и `order_events` защищены PostgreSQL-триггерами от `UPDATE` и
`DELETE`: история только дополняется.

## Почему повторы безопасны

- `payment_events.event_id` уникален, а платеж заказа имеет ключ `payment:<order_id>`;
- возврат позиции имеет ключ `refund:<item_id>`;
- запрос поставщику стабилен: `<item_id>-v<request_version>`;
- один код глобально уникален в `issued_codes`, одна позиция также может иметь
  только одну запись;
- очередь выдаёт job через lease и `FOR UPDATE SKIP LOCKED`;
- неоднозначный ответ сначала сверяется по тому же request id, новая версия
  создаётся только после доказанного дубля или чужого кода.

## Тесты

Unit-тесты не требуют базы:

```bash
npm test
```

Интеграционные тесты очищают таблицы, поэтому используйте отдельную базу:

```bash
docker compose exec postgres psql -U shop -d postgres -c 'CREATE DATABASE shop_test'
DATABASE_URL=postgres://shop:shop@localhost:5432/shop_test npm run db:migrate
TEST_DATABASE_URL=postgres://shop:shop@localhost:5432/shop_test npm run test:integration
```

Проверяются параллельные webhook, частичный возврат, неоднозначная ошибка,
дубликат кода, чужой SKU, восстановление после истёкшей lease, rate limit и
исторический snapshot.

## Ограничения демонстрационной реализации

Оплата, возврат и поставщики являются заглушками. В production provider lookup и
refund API вызываются через transactional outbox; секреты кодов шифруются, а
admin endpoints закрываются аутентификацией. Фиксированное окно rate limit можно
заменить token bucket, не меняя модель jobs.

Фактически затраченное время нужно указать перед отправкой тестового задания.
На техническом звонке готов внести небольшое изменение в код.
