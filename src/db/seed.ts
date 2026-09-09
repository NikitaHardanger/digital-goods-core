import { pool } from './index.js';

const products = [
  ['STEAM-TOPUP-500', 'Пополнение Steam 500 ₽', 'topup', 500, 'A'],
  ['STEAM-TOPUP-1000', 'Пополнение Steam 1000 ₽', 'topup', 1000, 'B'],
  ['STEAM-TOPUP-2500', 'Пополнение Steam 2500 ₽', 'topup', 2500, 'A'],
  ['KEY-CS2-PRIME', 'CS2 Prime Status ключ', 'key', 1290, 'A'],
  ['KEY-GTA5', 'GTA V ключ активации', 'key', 1990, 'B'],
  ['KEY-EFT', 'Escape from Tarkov ключ', 'key', 3490, 'A'],
  ['SUB-DISCORD-1M', 'Discord Nitro 1 месяц', 'subscription', 399, 'B'],
  ['SUB-YT-3M', 'YouTube Premium 3 месяца', 'subscription', 1490, 'A'],
  ['SUB-SPOTIFY-1M', 'Spotify Premium 1 месяц', 'subscription', 299, 'B'],
  ['GIFT-PSN-1000', 'PlayStation Store карта 1000 ₽', 'giftcard', 1000, 'A'],
  ['GIFT-XBOX-1500', 'Xbox Gift Card 1500 ₽', 'giftcard', 1500, 'B'],
  ['GIFT-ROBLOX-800', 'Roblox 800 Robux', 'giftcard', 890, 'B'],
];

for (const [sku, name, type, price, provider] of products) {
  await pool.query(
    `INSERT INTO products(sku,name,type,price,currency,provider)
     VALUES($1,$2,$3,$4,'RUB',$5)
     ON CONFLICT(sku) DO UPDATE SET
       name=EXCLUDED.name,type=EXCLUDED.type,price=EXCLUDED.price,
       currency=EXCLUDED.currency,provider=EXCLUDED.provider`,
    [sku, name, type, price, provider],
  );
}

await pool.end();
console.log('seeded');
