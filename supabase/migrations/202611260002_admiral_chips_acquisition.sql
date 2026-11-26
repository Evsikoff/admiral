BEGIN;

CREATE OR REPLACE FUNCTION public.admiral_chips_acquisition(
    user_id bigint,
    purchasing_chips_id bigint,
    details jsonb DEFAULT NULL
)
RETURNS TABLE (balance bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    p_user_id ALIAS FOR $1;
    p_package_id ALIAS FOR $2;
    p_details ALIAS FOR $3;
BEGIN
    IF p_user_id IS NULL OR p_package_id IS NULL THEN
        RAISE EXCEPTION 'Обязательны оба аргумента: user_id и purchasing_chips_id'
            USING ERRCODE = '22004';
    END IF;

    -- Serialize purchases for this user before inserting and reading the balance.
    PERFORM 1 FROM public.admiral_users AS u WHERE u.id = p_user_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Пользователь % не найден', p_user_id USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.admiral_user_chips (user_id, comment, value, details, purchasing_chips_id)
    SELECT p_user_id, 'Приобретение за донат', p.quantity, p_details, p.id
      FROM public.admiral_purchasing_chips AS p
     WHERE p.id = p_package_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Пакет фишек % не найден', p_package_id USING ERRCODE = '23503';
    END IF;

    RETURN QUERY
    SELECT COALESCE(sum(c.value), 0)::bigint
      FROM public.admiral_user_chips AS c
     WHERE c.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admiral_chips_acquisition(bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admiral_chips_acquisition(bigint, bigint, jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
