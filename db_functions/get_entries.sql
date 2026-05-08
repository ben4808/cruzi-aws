CREATE OR REPLACE FUNCTION get_entries (
    p_entries jsonb
)
RETURNS TABLE (
    entry text,
    lang text,
    root_entry text,
    length integer,
    display_text text,
    entry_type text,
    familiarity_score integer,
    quality_score integer,
    crossword_score integer,
    loading_status text
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        e."entry",
        e.lang,
        e.root_entry,
        e."length",
        e.display_text,
        e.entry_type,
        e.familiarity_score,
        e.quality_score,
        e.crossword_score,
        e.loading_status
    FROM "entry" e
    INNER JOIN (
        SELECT DISTINCT
            trim((i->>'entry')::text) AS entry,
            trim((i->>'lang')::text) AS lang
        FROM jsonb_array_elements(p_entries) AS i
        WHERE COALESCE(NULLIF(trim(i->>'entry'), ''), '') <> ''
          AND COALESCE(NULLIF(trim(i->>'lang'), ''), '') <> ''
    ) requested_entries
        ON requested_entries.entry = e."entry"
       AND requested_entries.lang = e.lang;
END;
$$;
