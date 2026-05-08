CREATE OR REPLACE FUNCTION get_crossword_quality_queue_top_25()
RETURNS TABLE (
    entry text,
    lang text
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Drop any rows that already have a quality score persisted.
    DELETE FROM crossword_quality_queue cqq
    USING "entry" e
    WHERE cqq.entry = e.entry
      AND cqq.lang = e.lang
      AND e.quality_score IS NOT NULL;

    RETURN QUERY
    WITH selected_rows AS (
        SELECT cqq.id, cqq.entry, cqq.lang
        FROM crossword_quality_queue cqq
        ORDER BY cqq.added_at ASC
        LIMIT 25
    ),
    deleted_rows AS (
        DELETE FROM crossword_quality_queue cqq
        USING selected_rows sr
        WHERE cqq.id = sr.id
        RETURNING sr.entry, sr.lang
    )
    SELECT dr.entry, dr.lang
    FROM deleted_rows dr;
END;
$$;
