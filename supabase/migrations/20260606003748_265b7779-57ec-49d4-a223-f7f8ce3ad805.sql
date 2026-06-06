ALTER TABLE public.bot_users 
  ADD COLUMN IF NOT EXISTS referred_by_telegram_id bigint,
  ADD COLUMN IF NOT EXISTS shares_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bot_users_referred_by ON public.bot_users(referred_by_telegram_id);