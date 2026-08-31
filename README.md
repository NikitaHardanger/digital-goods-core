# Digital goods core

Минимальное ядро магазина цифровых товаров: заказ по SKU, webhook оплаты и автоматическая выдача через двух тестовых поставщиков.

## Запуск

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run seed
npm run dev
```

Или запустить API и PostgreSQL полностью в контейнерах:

```bash
docker compose up --build
```

Создать заказ:

```bash
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"sku":"STEAM-TOPUP-500","idempotency_key":"ord_001"}'
```

Оплатить:

```bash
curl -X POST localhost:3000/webhook/payment -H 'content-type: application/json' \
  -d '{"event_id":"evt_001","order_id":"ord_001","status":"paid","amount":500,"currency":"RUB","created_at":"2025-01-01T12:00:00Z"}'
curl localhost:3000/orders/ord_001
```

Заглушки поставщиков доступны по контракту:

```bash
curl -X POST localhost:3000/providers/A/issue -H 'content-type: application/json' \
  -d '{"request_id":"req_001-1","sku":"STEAM-TOPUP-500","order_id":"ord_001"}'
```

Для воспроизведения отказов:

```bash
curl -X POST localhost:3000/admin/providers/A/config -H 'content-type: application/json' \
  -d '{"failRate":1,"timeoutRate":0}'
curl -X POST localhost:3000/admin/providers/A/config -H 'content-type: application/json' \
  -d '{"failRate":0,"timeoutRate":1,"reset":true}'
```

## Надёжность

`payment_events.event_id` — уникальный ключ идемпотентности webhook. Заказ блокируется `FOR UPDATE`, а финальная запись выдачи делается транзакционно. Поэтому 50 параллельных webhook-событий запускают максимум одну фактическую выдачу.

Поставщик хранит результат по `request_id`. После timeout повторяется тот же запрос к тому же поставщику; fallback B включается только после определённого отказа A. Это не маскирует неизвестный результат timeout новым запросом к другому источнику.

Ошибки `out_of_stock`/`delivery_failed` остаются восстановимыми. Для production стоит запускать `recover()` из worker/cron с lease на задания, добавить outbox для запуска доставки и журнал денежных движений.

## Проверка гонки

Для интеграционного теста создайте заказ, затем отправьте 50 одинаковых или разных `event_id` одновременно. После завершения запросите заказ: он должен быть `delivered`, а в `delivery_attempts` должна быть одна запись `ok`.

```bash
docker compose up -d postgres
npm run db:migrate && npm run seed
npm test
```

`npm test` запускает безопасные unit-тесты и ничего не скачивает. Интеграционные тесты очищают таблицы, поэтому запускаются отдельно только с выделенной базой:

```bash
docker compose exec postgres psql -U shop -d postgres -c 'CREATE DATABASE shop_test'
DATABASE_URL=postgres://shop:shop@localhost:5432/shop_test npm run db:migrate
TEST_DATABASE_URL=postgres://shop:shop@localhost:5432/shop_test npm run test:integration
```

Ручная проверка гонки:

```bash
seq 1 50 | xargs -P 50 -I{} curl -s -X POST localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{"event_id":"evt_{}","order_id":"ord_001","status":"paid","amount":500,"currency":"RUB","created_at":"2025-01-01T12:00:00Z"}' >/dev/null
```

## Масштабирование

Каталог читается по PK `products.sku`; фильтр очереди выдачи поддерживается индексом `orders_status_idx`. Для тысяч SKU этого достаточно. При росте нагрузки добавляются read replicas/cache каталога, connection pool и очередь с partitioning по `order_id`.
