CREATE OR REPLACE FUNCTION public.apply_referral(_new_user bigint, _referrer bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prev int;
  _next int;
  _updated int;
BEGIN
  IF _new_user IS NULL OR _referrer IS NULL OR _new_user = _referrer THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
  END IF;

  -- Only set referred_by once (if currently null) AND ensure new user exists
  UPDATE public.bot_users
     SET referred_by_telegram_id = _referrer
   WHERE telegram_id = _new_user
     AND referred_by_telegram_id IS NULL;
  GET DIAGNOSTICS _updated = ROW_COUNT;

  IF _updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_referred_or_missing');
  END IF;

  -- Ensure referrer exists; if not, rollback the link
  IF NOT EXISTS (SELECT 1 FROM public.bot_users WHERE telegram_id = _referrer) THEN
    UPDATE public.bot_users SET referred_by_telegram_id = NULL WHERE telegram_id = _new_user;
    RETURN jsonb_build_object('ok', false, 'reason', 'referrer_missing');
  END IF;

  UPDATE public.bot_users
     SET shares_count = COALESCE(shares_count, 0) + 1
   WHERE telegram_id = _referrer
  RETURNING COALESCE(shares_count, 0) INTO _next;

  _prev := _next - 1;
  RETURN jsonb_build_object('ok', true, 'prev', _prev, 'next', _next);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_referral(bigint, bigint) TO service_role;