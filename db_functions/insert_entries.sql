CREATE OR REPLACE FUNCTION insert_entries (
    p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert new entries with display_text
    INSERT INTO "entry" ("entry", lang, "length", display_text)
    SELECT
      (e->>'entry')::text,
      (e->>'lang')::text,
      (e->>'length')::integer,
      (e->>'display_text')::text
    FROM jsonb_array_elements(p_entries) AS e
    ON CONFLICT ("entry", lang) DO NOTHING;
END;
$$;
