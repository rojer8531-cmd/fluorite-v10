-- 1) Bloqueos temporales
ALTER TABLE public.blocked_users
  ADD COLUMN IF NOT EXISTS blocked_until timestamptz;

ALTER TABLE public.blocked_users
  ADD COLUMN IF NOT EXISTS infraction_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_blocked_users_until ON public.blocked_users (blocked_until);

-- 2) Seed productos (idempotente por nombre)
INSERT INTO public.products (name, category, sort_order) VALUES
  ('Fluorite iOS',  'iOS',     10),
  ('Monite iOS',    'iOS',     20),
  ('Drip Client',   'Android', 30),
  ('Pato Team',     'Android', 40)
ON CONFLICT DO NOTHING;

-- 3) Seed precios para cada producto
WITH p AS (
  SELECT id, name FROM public.products
  WHERE name IN ('Fluorite iOS','Monite iOS','Drip Client','Pato Team')
)
INSERT INTO public.product_prices (product_id, duration_label, duration_days, price_usd, sort_order)
SELECT p.id, v.label, v.days, v.price, v.ord
FROM p
CROSS JOIN (VALUES
  ('1 Día',    1,   5.00, 10),
  ('7 Días',   7,  20.00, 20),
  ('30 Días', 30,  30.00, 30)
) AS v(label, days, price, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM public.product_prices pp
  WHERE pp.product_id = p.id AND pp.duration_label = v.label
);

-- 4) Seed métodos de pago (idempotente por país+método)
INSERT INTO public.payment_methods
  (country_code, country_name, method_name, holder_name, account_info, usd_rate, currency, sort_order, extra_info)
VALUES
  ('VE','Venezuela','Pago Móvil','Carlos Pérez','0412-1234567 / V-12345678 / Banesco', 38.50,'VES', 10, NULL),
  ('VE','Venezuela','Binance USDT','VentasSX7','TRC20: TXyzAbC1234567890', 1.00,'USDT', 20, NULL),
  ('AR','Argentina','Mercado Pago','Lucía Gómez','alias: ventas.sx7', 1050.00,'ARS', 30, NULL),
  ('AR','Argentina','Transferencia','Lucía Gómez','CBU 0000003100000000000000', 1050.00,'ARS', 40, NULL),
  ('CO','Colombia','Nequi','Andrés Ramírez','3001234567', 4100.00,'COP', 50, NULL),
  ('CO','Colombia','Daviplata','Andrés Ramírez','3001234567', 4100.00,'COP', 60, NULL),
  ('PE','Perú','Yape','María López','987654321', 3.75,'PEN', 70, NULL),
  ('PE','Perú','Plin','María López','987654321', 3.75,'PEN', 80, NULL),
  ('MX','México','OXXO Spin','Juan Hernández','5512345678', 17.50,'MXN', 90, NULL),
  ('CL','Chile','MACH','Pedro Soto','+56912345678', 950.00,'CLP', 100, NULL),
  ('EC','Ecuador','Banco Pichincha','Roberto Vera','Cta. Ahorros 2201234567', 1.00,'USD', 110, NULL),
  ('BO','Bolivia','BCP','Sofía Mendoza','Cta. 371674409', 6.96,'BOB', 120, NULL),
  ('GT','Guatemala','Banrural','Oxael Virula','4431164091', 7.80,'GTQ', 130, NULL),
  ('ES','España','Bizum','Xiomari Moreno','637070926', 0.92,'EUR', 140, NULL)
ON CONFLICT DO NOTHING;
