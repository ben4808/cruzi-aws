CREATE OR REPLACE FUNCTION add_clues_to_collection (
    clues_data jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO clue (
        id,
        "entry",
        lang,
        sense_id,
        custom_clue,
        custom_display_text
    )
    SELECT
        (clue_item->>'id')::text,
        (clue_item->>'entry')::text,
        (clue_item->>'lang')::text,
        NULLIF((clue_item->>'sense_id')::text, ''),
        NULLIF((clue_item->>'custom_clue')::text, ''),
        NULLIF((clue_item->>'custom_display_text')::text, '')
    FROM jsonb_array_elements(clues_data) AS clue_item
    WHERE COALESCE((clue_item->>'entry')::text, '') <> ''
    ON CONFLICT (id) DO UPDATE
    SET "entry" = EXCLUDED."entry",
        lang = EXCLUDED.lang,
        sense_id = EXCLUDED.sense_id,
        custom_clue = EXCLUDED.custom_clue,
        custom_display_text = EXCLUDED.custom_display_text;

    INSERT INTO collection__clue (
        collection_id,
        clue_id,
        "order",
        metadata1,
        metadata2
    )
    SELECT
        (clue_item->>'collection_id')::text,
        (clue_item->>'id')::text,
        COALESCE((clue_item->>'order')::int, clue_order::int - 1),
        NULLIF((clue_item->>'metadata1')::text, ''),
        NULLIF((clue_item->>'metadata2')::text, '')
    FROM jsonb_array_elements(clues_data) WITH ORDINALITY AS clues(clue_item, clue_order)
    WHERE COALESCE((clue_item->>'entry')::text, '') <> ''
      AND COALESCE((clue_item->>'collection_id')::text, '') <> ''
    ON CONFLICT (collection_id, clue_id) DO UPDATE
    SET "order" = EXCLUDED."order",
        metadata1 = EXCLUDED.metadata1,
        metadata2 = EXCLUDED.metadata2;
END;
$$;
