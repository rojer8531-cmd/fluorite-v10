
CREATE TABLE public.announcements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  preview TEXT NOT NULL DEFAULT '',
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  total_sent INT NOT NULL DEFAULT 0,
  total_failed INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.announcements TO service_role;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access announcements" ON public.announcements FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.announcement_deliveries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  chat_id BIGINT NOT NULL,
  message_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ann_deliv_user ON public.announcement_deliveries(telegram_id, read_at);
CREATE INDEX idx_ann_deliv_ann ON public.announcement_deliveries(announcement_id);
GRANT ALL ON public.announcement_deliveries TO service_role;
ALTER TABLE public.announcement_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access ann_deliv" ON public.announcement_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);
