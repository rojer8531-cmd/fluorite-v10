CREATE TABLE public.admin_trash (
  message_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, message_id)
);

GRANT ALL ON public.admin_trash TO service_role;

ALTER TABLE public.admin_trash ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.admin_trash FOR ALL USING (false) WITH CHECK (false);

CREATE INDEX idx_admin_trash_chat ON public.admin_trash (chat_id, created_at);