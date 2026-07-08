REVOKE EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purchase_manual_atomic(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.purchase_manual_atomic(bigint, uuid) TO service_role;
