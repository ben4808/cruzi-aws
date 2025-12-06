CREATE OR REPLACE FUNCTION add_example_sentence_queue_entries(
    p_sense_ids jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    sense_id text;
BEGIN
    -- Process each sense_id
    FOR sense_id IN SELECT * FROM jsonb_array_elements_text(p_sense_ids)
    LOOP
        -- Check if this sense already has 3 or more example sentences
        IF (SELECT COUNT(*) FROM example_sentence WHERE sense_id = sense_id) < 3 THEN
            INSERT INTO example_sentence_queue (sense_id)
            VALUES (sense_id)
            ON CONFLICT DO NOTHING; -- Avoid duplicates
        END IF;
    END LOOP;
END;
$$;
