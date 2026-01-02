CREATE OR REPLACE FUNCTION assign_primary_sense_to_clues(
    p_entry text,
    p_lang text,
    p_primary_sense_id text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Update clues that have the specified entry and lang,
    -- but no sense_id and no custom_clue, to use the primary sense_id
    UPDATE clue
    SET sense_id = p_primary_sense_id
    WHERE "entry" = p_entry
      AND lang = p_lang
      AND sense_id IS NULL
      AND custom_clue IS NULL;
END;
$$;
