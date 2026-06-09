ALTER TABLE public.telegram_bot_settings ADD COLUMN IF NOT EXISTS min_recharge_usd NUMERIC(10,2) NOT NULL DEFAULT 4.00;
UPDATE public.telegram_bot_settings SET min_recharge_usd = 4.00 WHERE singleton = true;
INSERT INTO public.telegram_bot_settings (singleton, min_recharge_usd) VALUES (true, 4.00) ON CONFLICT (singleton) DO NOTHING;