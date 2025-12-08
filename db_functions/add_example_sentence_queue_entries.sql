CREATE OR REPLACE FUNCTION add_example_sentence_queue_entries(
    p_sense_ids jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_sense_id text; -- Renamed local variable
BEGIN
    -- Process each sense_id
    FOR v_sense_id IN SELECT * FROM jsonb_array_elements_text(p_sense_ids)
    LOOP
        -- Check if this sense already has 3 or more example sentences
        IF (SELECT COUNT(*) FROM example_sentence es WHERE es.sense_id = v_sense_id) < 3 THEN
            INSERT INTO example_sentence_queue (sense_id)
            VALUES (v_sense_id)
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END;
$$;
