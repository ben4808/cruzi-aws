CREATE OR REPLACE FUNCTION get_entry_info_queue_top_10()
RETURNS TABLE (
    entry text,
    display_text text,
    lang text,
    existing_sense_ids text[],
    existing_sense_summaries text[],
    example_sentence_count integer
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH top_entries AS (
        SELECT eiq.entry, eiq.lang, eiq.id, e.display_text
        FROM entry_info_queue eiq
        LEFT JOIN entry e ON e.entry = eiq.entry AND e.lang = eiq.lang
        ORDER BY eiq.added_at ASC
        LIMIT 10
    ),
    entry_data AS (
        SELECT
            te.entry,
            te.display_text,
            te.lang,
            COALESCE(array_agg(s.id::text) FILTER (WHERE s.id IS NOT NULL), ARRAY[]::text[]) as existing_sense_ids,
            COALESCE(array_agg(st.summary) FILTER (WHERE st.summary IS NOT NULL), ARRAY[]::text[]) as existing_sense_summaries,
            COALESCE(SUM(es_count.count), 0)::integer as example_sentence_count
        FROM top_entries te
        LEFT JOIN sense s ON s.entry = te.entry AND s.lang = te.lang
        LEFT JOIN sense_translation st ON st.sense_id = s.id AND st.lang = te.lang
        LEFT JOIN (
            SELECT sense_id, COUNT(*) as count
            FROM example_sentence
            GROUP BY sense_id
        ) es_count ON es_count.sense_id = s.id
        GROUP BY te.entry, te.display_text, te.lang
    )
    SELECT ed.entry, ed.display_text, ed.lang, ed.existing_sense_ids, ed.existing_sense_summaries, ed.example_sentence_count
    FROM entry_data ed;

    -- Delete the processed entries from the queue
    DELETE FROM entry_info_queue
    WHERE id IN (
        SELECT id
        FROM entry_info_queue
        ORDER BY added_at ASC
        LIMIT 10
    );
END;
$$;
