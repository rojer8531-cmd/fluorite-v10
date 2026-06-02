
-- =====================================================
-- ENUMS
-- =====================================================
CREATE TYPE public.user_rank AS ENUM ('normal', 'pro', 'leyenda');
CREATE TYPE public.order_status AS ENUM ('pending_receipt', 'pending_approval', 'approved', 'rejected', 'delivered', 'cancelled');
CREATE TYPE public.receipt_status AS ENUM ('pending', 'approved', 'rejected', 'duplicate');

-- =====================================================
-- TIMESTAMP TRIGGER
-- =====================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- =====================================================
-- BOT USERS
-- =====================================================
CREATE TABLE public.bot_users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  chat_id BIGINT NOT NULL,
  username TEXT,
  display_name TEXT,
  password_hash TEXT,
  is_authenticated BOOLEAN NOT NULL DEFAULT false,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_recharged NUMERIC(12,2) NOT NULL DEFAULT 0,
  rank user_rank NOT NULL DEFAULT 'normal',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_users_telegram_id ON public.bot_users(telegram_id);

GRANT ALL ON public.bot_users TO service_role;
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_bot_users" ON public.bot_users FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_bot_users_updated BEFORE UPDATE ON public.bot_users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- USER STATE (state machine + single-flight lock)
-- =====================================================
CREATE TABLE public.user_state (
  telegram_id BIGINT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'idle',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  start_lock_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.user_state TO service_role;
ALTER TABLE public.user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_user_state" ON public.user_state FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_user_state_updated BEFORE UPDATE ON public.user_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- ACTIVE MESSAGES (1 mensaje activo por usuario)
-- =====================================================
CREATE TABLE public.active_messages (
  telegram_id BIGINT NOT NULL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.active_messages TO service_role;
ALTER TABLE public.active_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_active_messages" ON public.active_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- PRODUCTS
-- =====================================================
CREATE TABLE public.products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_products" ON public.products FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- PRODUCT PRICES (precio por duración)
-- =====================================================
CREATE TABLE public.product_prices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  duration_label TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  price_usd NUMERIC(12,2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_prices_product ON public.product_prices(product_id);
GRANT ALL ON public.product_prices TO service_role;
ALTER TABLE public.product_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_product_prices" ON public.product_prices FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- STOCK DE KEYS (para entrega automática)
-- =====================================================
CREATE TABLE public.product_stock_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  price_id UUID NOT NULL REFERENCES public.product_prices(id) ON DELETE CASCADE,
  key_value TEXT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  used_at TIMESTAMPTZ,
  used_by_user_id UUID REFERENCES public.bot_users(id),
  used_by_order_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_keys_avail ON public.product_stock_keys(product_id, price_id, used);
GRANT ALL ON public.product_stock_keys TO service_role;
ALTER TABLE public.product_stock_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_stock_keys" ON public.product_stock_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- PAYMENT METHODS
-- =====================================================
CREATE TABLE public.payment_methods (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  method_name TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  account_info TEXT NOT NULL,
  extra_info TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  usd_rate NUMERIC(14,6) NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_methods_country ON public.payment_methods(country_code, active);
GRANT ALL ON public.payment_methods TO service_role;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_payment_methods" ON public.payment_methods FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_payment_methods_updated BEFORE UPDATE ON public.payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- ORDERS
-- =====================================================
CREATE TABLE public.orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  product_id UUID NOT NULL REFERENCES public.products(id),
  price_id UUID NOT NULL REFERENCES public.product_prices(id),
  payment_method_id UUID REFERENCES public.payment_methods(id),
  keys_qty INTEGER NOT NULL DEFAULT 1,
  total_usd NUMERIC(12,2) NOT NULL,
  total_local NUMERIC(14,2),
  currency TEXT,
  status order_status NOT NULL DEFAULT 'pending_receipt',
  paid_with_balance BOOLEAN NOT NULL DEFAULT false,
  receipt_id UUID,
  admin_message_id BIGINT,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_user ON public.orders(user_id);
CREATE INDEX idx_orders_status ON public.orders(status);
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_orders" ON public.orders FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- ORDER KEYS
-- =====================================================
CREATE TABLE public.order_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  key_value TEXT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_keys_order ON public.order_keys(order_id);
CREATE INDEX idx_order_keys_user ON public.order_keys(user_id);
GRANT ALL ON public.order_keys TO service_role;
ALTER TABLE public.order_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_order_keys" ON public.order_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- RECEIPTS
-- =====================================================
CREATE TABLE public.receipts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.bot_users(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  status receipt_status NOT NULL DEFAULT 'pending',
  admin_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_receipts_user ON public.receipts(user_id);
CREATE INDEX idx_receipts_order ON public.receipts(order_id);
GRANT ALL ON public.receipts TO service_role;
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_receipts" ON public.receipts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_receipts_updated BEFORE UPDATE ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================
-- RECEIPT FINGERPRINTS (anti duplicado 24h)
-- =====================================================
CREATE TABLE public.receipt_fingerprints (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  file_unique_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  telegram_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_fingerprint_unique ON public.receipt_fingerprints(file_unique_id);
CREATE INDEX idx_fingerprint_created ON public.receipt_fingerprints(created_at);
GRANT ALL ON public.receipt_fingerprints TO service_role;
ALTER TABLE public.receipt_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_fingerprints" ON public.receipt_fingerprints FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- BLOCKED USERS
-- =====================================================
CREATE TABLE public.blocked_users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  reason TEXT,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.blocked_users TO service_role;
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_blocked" ON public.blocked_users FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- ADMIN LOGS
-- =====================================================
CREATE TABLE public.admin_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_telegram_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.admin_logs TO service_role;
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_admin_logs" ON public.admin_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- RATE LIMITS (anti-spam)
-- =====================================================
CREATE TABLE public.rate_limits (
  telegram_id BIGINT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, bucket)
);
GRANT ALL ON public.rate_limits TO service_role;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_rate_limits" ON public.rate_limits FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================
-- SEED: PAYMENT METHODS (los 13 que especificaste)
-- =====================================================
INSERT INTO public.payment_methods (country_code, country_name, method_name, holder_name, account_info, currency, usd_rate, sort_order) VALUES
('AR', '🇦🇷 Argentina', 'Mercado Pago', 'Francisco Carrizo', 'Alias: tommydll', 'ARS', 1000, 1),
('BO', '🇧🇴 Bolivia', 'Yasta', 'Rosemary Cervantes', 'Número: 71007107', 'BOB', 6.96, 2),
('BR', '🇧🇷 Brasil', 'Pix', 'Gabriela Lírio', 'Email: vianahiago1997@gmail.com', 'BRL', 5.5, 3),
('CO', '🇨🇴 Colombia', 'Nequi', 'Brenda Ramirez', 'Número: 3118802212', 'COP', 4000, 4),
('US', '🇺🇸 Estados Unidos', 'Zelle', 'Jordan Cruz', 'Número: 7753787531', 'USD', 1, 5),
('MX', '🇲🇽 México', 'BBVA / OXXO', 'David Peña', 'Cuenta: 4152314556767013', 'MXN', 17, 6),
('PE', '🇵🇪 Perú', 'Yape / Plin / Agora', 'Jaime Guevara', 'Número: 928574897', 'PEN', 3.75, 7),
('DO', '🇩🇴 República Dominicana', 'Banreservas', 'Ezequiel Gómez', 'Número: 9601546622', 'DOP', 60, 8),
('UY', '🇺🇾 Uruguay', 'Prex', 'Jaime Guevara', 'Número: 14591044', 'UYU', 40, 9),
('BNB', '🌐 Binance', 'Binance Pay', 'MrFresaYT', 'ID: 181500068', 'USD', 1, 10),
('HN', '🇭🇳 Honduras', 'Bampais', 'Guillermo Herrera', 'Número: 216400100524', 'HNL', 24.8, 11),
('NI', '🇳🇮 Nicaragua', 'BAC', 'Marnuth Sanchez', 'Número: 371674409', 'NIO', 36.6, 12),
('GT', '🇬🇹 Guatemala', 'Banrural', 'Oxael Virula', 'Número: 4431164091', 'GTQ', 7.8, 13),
('ES', '🇪🇸 España', 'Bizum', 'Xiomari Moreno', 'Número: 637070926', 'EUR', 0.92, 14);

-- =====================================================
-- SEED: PRODUCTO DE EJEMPLO
-- =====================================================
INSERT INTO public.products (id, name, description, sort_order)
VALUES ('11111111-1111-1111-1111-111111111111', 'Producto Demo', 'Producto de ejemplo - editá desde el bot admin', 1);

INSERT INTO public.product_prices (product_id, duration_label, duration_days, price_usd, sort_order) VALUES
('11111111-1111-1111-1111-111111111111', '1 día', 1, 1.00, 1),
('11111111-1111-1111-1111-111111111111', '7 días', 7, 5.00, 2),
('11111111-1111-1111-1111-111111111111', '30 días', 30, 15.00, 3);
