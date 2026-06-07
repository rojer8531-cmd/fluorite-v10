CREATE TABLE public.user_price_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT NOT NULL,
  price_id UUID NOT NULL REFERENCES public.product_prices(id) ON DELETE CASCADE,
  price_usd NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, price_id)
);

GRANT ALL ON public.user_price_overrides TO service_role;

ALTER TABLE public.user_price_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.user_price_overrides
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_user_price_overrides_tg ON public.user_price_overrides (telegram_id);

CREATE TRIGGER update_user_price_overrides_updated_at
  BEFORE UPDATE ON public.user_price_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();