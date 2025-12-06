CREATE OR REPLACE FUNCTION add_clues_to_collection (
    p_collection_id text,
    p_clues jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert new clues
    INSERT INTO clue (id, "entry", lang, clue, response_template, source)
    SELECT
        (cl->>'clue_id')::text,
        (cl->>'entry')::text,
        (cl->>'lang')::text,
        (cl->>'clue')::text,
        (cl->>'response_template')::text,
        (cl->>'source')::text
    FROM jsonb_array_elements(p_clues) AS cl;

    -- Insert collection-clue relationships
    INSERT INTO collection__clue (collection_id, clue_id, "order", metadata1)
    SELECT
        p_collection_id,
        (cl->>'clue_id')::text,
        (cl->>'order')::integer,
        (cl->>'metadata1')::text
    FROM jsonb_array_elements(p_clues) AS cl;
END;
$$;
