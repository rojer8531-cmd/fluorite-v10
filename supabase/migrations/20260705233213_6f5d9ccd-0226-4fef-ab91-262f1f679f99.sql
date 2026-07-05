
-- Panel Web admin fase 1: precios con original + oferta y RPC de compra atómica de key

ALTER TABLE public.product_prices
  ADD COLUMN IF NOT EXISTS original_price_usd numeric(12,2),
  ADD COLUMN IF NOT EXISTS sale_price_usd numeric(12,2),
  ADD COLUMN IF NOT EXISTS sale_ends_at timestamptz;

-- Categorías dinámicas (permitir crear nuevas sin tocar enum)
CREATE TABLE IF NOT EXISTS public.product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.product_categories TO service_role;
ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_product_categories" ON public.product_categories
  TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.product_categories(name, sort_order) VALUES ('iOS', 0), ('Android', 1)
ON CONFLICT (name) DO NOTHING;

-- Log de acciones del panel web
CREATE TABLE IF NOT EXISTS public.panel_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  entity text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.panel_action_logs TO service_role;
ALTER TABLE public.panel_action_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_panel_logs" ON public.panel_action_logs
  TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_panel_logs_created ON public.panel_action_logs(created_at DESC);

-- RPC atómica: descuenta saldo, toma una key, la marca como usada, crea orden y order_key.
-- Nunca puede vender la misma key dos veces gracias a FOR UPDATE SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.purchase_key_atomic(
  _telegram_id bigint,
  _price_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user public.bot_users%ROWTYPE;
  _price public.product_prices%ROWTYPE;
  _product public.products%ROWTYPE;
  _override numeric;
  _unit numeric;
  _key public.product_stock_keys%ROWTYPE;
  _order_id uuid;
BEGIN
  SELECT * INTO _user FROM public.bot_users WHERE telegram_id = _telegram_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_missing');
  END IF;

  SELECT * INTO _price FROM public.product_prices WHERE id = _price_id AND active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'price_missing');
  END IF;

  SELECT * INTO _product FROM public.products WHERE id = _price.product_id AND active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'product_inactive');
  END IF;

  -- Precio efectivo: override de usuario > sale activa > precio normal
  SELECT price_usd INTO _override FROM public.user_price_overrides
    WHERE telegram_id = _telegram_id AND price_id = _price_id;

  IF _override IS NOT NULL THEN
    _unit := _override;
  ELSIF _price.sale_price_usd IS NOT NULL
      AND (_price.sale_ends_at IS NULL OR _price.sale_ends_at > now()) THEN
    _unit := _price.sale_price_usd;
  ELSE
    _unit := _price.price_usd;
  END IF;

  IF COALESCE(_user.balance, 0) < _unit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance',
      'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  -- Reserva atómica de una key libre
  SELECT * INTO _key FROM public.product_stock_keys
    WHERE price_id = _price_id AND used = false
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'out_of_stock');
  END IF;

  -- Descuenta saldo
  UPDATE public.bot_users
    SET balance = balance - _unit
    WHERE id = _user.id;

  -- Crea orden
  INSERT INTO public.orders(
    user_id, telegram_id, product_id, price_id, keys_qty,
    total_usd, status, paid_with_balance, order_type
  ) VALUES (
    _user.id, _telegram_id, _product.id, _price.id, 1,
    _unit, 'delivered'::order_status, true, 'purchase'
  ) RETURNING id INTO _order_id;

  -- Marca la key como usada y la asocia
  UPDATE public.product_stock_keys
    SET used = true, used_at = now(),
        used_by_user_id = _user.id, used_by_order_id = _order_id
    WHERE id = _key.id;

  INSERT INTO public.order_keys(order_id, user_id, key_value)
    VALUES (_order_id, _user.id, _key.key_value);

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', _order_id,
    'key_value', _key.key_value,
    'unit_usd', _unit,
    'new_balance', COALESCE(_user.balance, 0) - _unit,
    'product_name', _product.name,
    'duration_label', _price.duration_label
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_key_atomic(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) TO service_role;
