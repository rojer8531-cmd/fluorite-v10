
-- Add new rank values
ALTER TYPE public.user_rank ADD VALUE IF NOT EXISTS 'gold';
ALTER TYPE public.user_rank ADD VALUE IF NOT EXISTS 'platinum';
ALTER TYPE public.user_rank ADD VALUE IF NOT EXISTS 'diamond';
ALTER TYPE public.user_rank ADD VALUE IF NOT EXISTS 'elite';

-- Rank assignment timestamp
ALTER TABLE public.bot_users
  ADD COLUMN IF NOT EXISTS rank_assigned_at timestamptz NOT NULL DEFAULT now();

-- History of rank changes
CREATE TABLE IF NOT EXISTS public.rank_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL,
  old_rank public.user_rank,
  new_rank public.user_rank NOT NULL,
  changed_by text NOT NULL DEFAULT 'system',
  admin_telegram_id bigint,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rank_history TO authenticated;
GRANT ALL ON public.rank_history TO service_role;

ALTER TABLE public.rank_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_rank_history" ON public.rank_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_rank_history_tg ON public.rank_history(telegram_id, created_at DESC);
