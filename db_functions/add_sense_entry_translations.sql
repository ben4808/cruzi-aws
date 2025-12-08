CREATE OR REPLACE FUNCTION add_sense_entry_translations (
    p_translations jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert sense entry translations
    INSERT INTO sense_entry_translation (sense_id, "entry", lang, display_text)
    SELECT
      (t->>'sense_id')::text,
      (t->>'entry')::text,
      (t->>'lang')::text,
      (t->>'display_text')::text
    FROM jsonb_array_elements(p_translations) AS t
    ON CONFLICT (sense_id, "entry", lang) DO NOTHING;
END;
$$;
