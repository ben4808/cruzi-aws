CREATE OR REPLACE FUNCTION update_entries_loading_status (
    p_entries jsonb,
    p_status text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Update loading status for the provided entries
    UPDATE "entry"
    SET loading_status = p_status
    WHERE ("entry", lang) IN (
        SELECT
            (e->>'entry')::text,
            (e->>'lang')::text
        FROM jsonb_array_elements(p_entries) AS e
    );
END;
$$;