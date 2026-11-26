-- The existing (party_id, winner_user_id) RPC handles human winners.
-- PostgREST selects this overload when the caller provides party_id and bot_name.
BEGIN;

CREATE OR REPLACE FUNCTION public.admiral_online_party_results(party_id bigint, bot_name text)
RETURNS TABLE (winnings_amount bigint, winner_user_balance bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    p_party_id ALIAS FOR $1;
    p_bot_name ALIAS FOR $2;
    finished_at timestamptz;
    chosen_id bigint;
    winner_count bigint;
    matching_winner_count bigint;
BEGIN
    IF p_party_id IS NULL OR NULLIF(btrim(p_bot_name), '') IS NULL THEN
        RAISE EXCEPTION 'Обязательны оба аргумента: party_id и bot_name'
            USING ERRCODE = '22004';
    END IF;

    -- Both overloads take the same locks in the same order.
    SELECT p.finish INTO finished_at
      FROM public.admiral_parties AS p
     WHERE p.id = p_party_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Партия % не найдена', p_party_id;
    END IF;

    SELECT min(s.id) FILTER (WHERE s.bot = p_bot_name),
           count(*) FILTER (WHERE s.winner),
           count(*) FILTER (WHERE s.winner AND s.bot = p_bot_name)
      INTO chosen_id, winner_count, matching_winner_count
      FROM (
          SELECT pp.id, pp.bot, pp.winner
            FROM public.admiral_parties_participants AS pp
           WHERE pp.party_id = p_party_id
           ORDER BY pp.id
             FOR UPDATE
      ) AS s;

    IF chosen_id IS NULL THEN
        RAISE EXCEPTION 'Бот «%» не участвует в партии %', p_bot_name, p_party_id;
    ELSIF finished_at IS NOT NULL THEN
        IF winner_count <> 1 OR matching_winner_count <> 1 THEN
            RAISE EXCEPTION 'У партии % уже зафиксирован другой результат', p_party_id;
        END IF;
    ELSIF winner_count <> 0 THEN
        RAISE EXCEPTION 'В незавершённой партии % уже отмечен победитель', p_party_id;
    ELSE
        UPDATE public.admiral_parties_participants SET winner = true WHERE id = chosen_id;
        UPDATE public.admiral_parties SET finish = clock_timestamp() WHERE id = p_party_id;
    END IF;

    RETURN QUERY SELECT 0::bigint, NULL::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.admiral_online_party_results(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admiral_online_party_results(bigint, text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
