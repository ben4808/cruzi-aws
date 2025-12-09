CREATE OR REPLACE FUNCTION add_example_sentences(
    p_sense_id text,
    p_example_sentences jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    sentence_record jsonb;
    example_id text;
    lang text;
    sentence_text text;
BEGIN
    -- Process each example sentence
    FOR sentence_record IN SELECT * FROM jsonb_array_elements(p_example_sentences)
    LOOP
        -- Generate a new ID for the example sentence
        example_id := gen_random_uuid()::text;

        -- Insert the example sentence
        INSERT INTO example_sentence (id, sense_id)
        VALUES (example_id, p_sense_id);

        -- Insert translations for each language
        FOR lang, sentence_text IN SELECT key, value FROM jsonb_each_text(sentence_record->'translations')
        LOOP
            INSERT INTO example_sentence_translation (example_id, lang, sentence)
            VALUES (example_id, lang, sentence_text);
        END LOOP;
    END LOOP;
END;
$$;
