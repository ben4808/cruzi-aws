CREATE OR REPLACE FUNCTION add_translate_results (
    p_translate_results jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert into translated_clue
    INSERT INTO translated_clue (clue_id, lang, literal_translation, natural_translation, source_ai)
    SELECT
        (trans->>'clue_id')::text,
        (trans->>'translated_lang')::text,
        (trans->>'literal_translation')::text,
        (trans->>'natural_translation')::text,
        (trans->>'source_ai')::text
    FROM jsonb_array_elements(p_translate_results) AS trans
    ON CONFLICT (clue_id, lang, source_ai) DO UPDATE
    SET literal_translation = EXCLUDED.literal_translation,
        natural_translation = EXCLUDED.natural_translation;

    -- Process and insert natural answers into translated_entry and entry tables
    PERFORM _process_answers(p_translate_results, 'natural_answers', 'translated_lang');

    -- Process and insert colloquial answers into translated_entry and entry tables
    PERFORM _process_answers(p_translate_results, 'colloquial_answers', 'translated_lang');

    -- Process and insert alternative English answers into translated_entry and entry tables
    PERFORM _process_answers(p_translate_results, 'alternative_english_answers', 'original_lang');

END;
$$;
