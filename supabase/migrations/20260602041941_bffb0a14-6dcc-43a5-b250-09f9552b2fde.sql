DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'product_category' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.product_category AS ENUM ('iOS', 'Android');
  END IF;
END $$;

ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS category public.product_category NOT NULL DEFAULT 'Android';

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name_category_unique
ON public.products(name, category);

ALTER TABLE public.product_prices
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_prices_product_duration_unique
ON public.product_prices(product_id, duration_days);

DROP TRIGGER IF EXISTS trg_product_prices_updated ON public.product_prices;
CREATE TRIGGER trg_product_prices_updated BEFORE UPDATE ON public.product_prices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.telegram_bot_settings (
  singleton BOOLEAN NOT NULL DEFAULT true PRIMARY KEY,
  hide_out_of_stock BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.telegram_bot_settings TO service_role;
ALTER TABLE public.telegram_bot_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all_telegram_bot_settings" ON public.telegram_bot_settings;
CREATE POLICY "service_role_all_telegram_bot_settings" ON public.telegram_bot_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_telegram_bot_settings_updated ON public.telegram_bot_settings;
CREATE TRIGGER trg_telegram_bot_settings_updated BEFORE UPDATE ON public.telegram_bot_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.telegram_bot_settings (singleton, hide_out_of_stock)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;