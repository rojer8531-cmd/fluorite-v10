CREATE OR REPLACE FUNCTION public.purchase_key_atomic(_telegram_id bigint, _price_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _user public.bot_users%ROWTYPE;
  _price public.product_prices%ROWTYPE;
  _product public.products%ROWTYPE;
  _override numeric;
  _unit numeric;
  _rank text;
  _shares int;
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

  _rank := COALESCE(_user.rank::text, 'gold');
  IF _rank IN ('pro', 'platinum') THEN
    _unit := round((_unit * 0.995)::numeric, 2);
  ELSIF _rank IN ('leyenda', 'diamond') THEN
    _unit := round((_unit * 0.99)::numeric, 2);
  ELSIF _rank = 'elite' THEN
    IF abs(_unit - 30) < 0.005 THEN
      _unit := 25;
    ELSE
      _unit := round((_unit * 0.99)::numeric, 2);
    END IF;
  ELSE
    _unit := round(_unit::numeric, 2);
  END IF;

  _shares := COALESCE(_user.shares_count, 0);
  IF _shares >= 30 THEN
    _unit := greatest(0, round((_unit - 1)::numeric, 2));
  END IF;

  IF COALESCE(_user.balance, 0) < _unit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance',
      'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  SELECT * INTO _key FROM public.product_stock_keys
    WHERE price_id = _price_id AND used = false
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'out_of_stock');
  END IF;

  UPDATE public.bot_users
    SET balance = balance - _unit
    WHERE id = _user.id AND balance >= _unit;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance',
      'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  INSERT INTO public.orders(
    user_id, telegram_id, product_id, price_id, keys_qty,
    total_usd, status, paid_with_balance, order_type
  ) VALUES (
    _user.id, _telegram_id, _product.id, _price.id, 1,
    _unit, 'delivered'::order_status, true, 'purchase'
  ) RETURNING id INTO _order_id;

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
$function$;

CREATE INDEX IF NOT EXISTS idx_orders_status_created_desc ON public.orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_tg_created ON public.admin_logs (admin_telegram_id, created_at DESC);