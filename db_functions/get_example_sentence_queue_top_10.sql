CREATE OR REPLACE FUNCTION get_example_sentence_queue_top_10()
RETURNS TABLE (
    sense_id text,
    "entry" text,
    display_text text,
    lang text,
    sense_summary text
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        esq.sense_id,
        s.entry,
        e.display_text,
        s.lang,
        st.summary as sense_summary
    FROM example_sentence_queue esq
    JOIN sense s ON s.id = esq.sense_id
    LEFT JOIN entry e ON e.entry = s.entry AND e.lang = s.lang
    LEFT JOIN sense_translation st ON st.sense_id = esq.sense_id AND st.lang = s.lang
    ORDER BY esq.added_at ASC
    LIMIT 10;

    -- Delete the processed entries from the queue
    DELETE FROM example_sentence_queue esq_delete
    WHERE esq_delete.sense_id IN (
        SELECT esq_inner.sense_id
        FROM example_sentence_queue esq_inner
        ORDER BY esq_inner.added_at ASC
        LIMIT 10
    );
END;
$$;
