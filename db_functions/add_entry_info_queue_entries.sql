CREATE OR REPLACE FUNCTION add_entry_info_queue_entries (
    p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO entry_info_queue ("entry", lang)
    SELECT
        trim((e->>'entry')::text),
        trim((e->>'lang')::text)
    FROM jsonb_array_elements(p_entries) AS e
    WHERE COALESCE(NULLIF(trim(e->>'entry'), ''), '') <> ''
      AND COALESCE(NULLIF(trim(e->>'lang'), ''), '') <> '';
END;
$$;
