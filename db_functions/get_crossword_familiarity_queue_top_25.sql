CREATE OR REPLACE FUNCTION get_crossword_familiarity_queue_top_25()
RETURNS TABLE (
    entry text,
    lang text
)
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM crossword_familiarity_queue cfq
    USING "entry" e
    WHERE cfq.entry = e.entry
      AND cfq.lang = e.lang
      AND e.familiarity_score IS NOT NULL;

    RETURN QUERY
    WITH selected_rows AS (
        SELECT cfq.id, cfq.entry, cfq.lang
        FROM crossword_familiarity_queue cfq
        ORDER BY cfq.added_at ASC
        LIMIT 25
    ),
    deleted_rows AS (
        DELETE FROM crossword_familiarity_queue cfq
        USING selected_rows sr
        WHERE cfq.id = sr.id
        RETURNING sr.entry, sr.lang
    )
    SELECT dr.entry, dr.lang
    FROM deleted_rows dr;
END;
$$;
