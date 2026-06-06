DROP INDEX IF EXISTS public.idx_fingerprint_unique;
CREATE INDEX IF NOT EXISTS idx_fingerprint_unique_tg ON public.receipt_fingerprints (file_unique_id, telegram_id);