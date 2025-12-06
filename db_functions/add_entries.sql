CREATE OR REPLACE FUNCTION add_entries (
    p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert new entries
    INSERT INTO "entry" ("entry", lang, "length")
    SELECT
      (e->>'entry')::text,
      (e->>'lang')::text,
      (e->>'length')::integer
    FROM jsonb_array_elements(p_entries) AS e
    ON CONFLICT ("entry", lang) DO NOTHING;
END;
$$;
