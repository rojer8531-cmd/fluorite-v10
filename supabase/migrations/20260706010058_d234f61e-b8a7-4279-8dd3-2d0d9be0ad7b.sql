REVOKE EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_key_atomic(bigint, uuid) TO service_role;