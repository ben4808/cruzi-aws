CREATE OR REPLACE FUNCTION add_clue_collection (
    p_collection_id text,
    p_puzzle_id text,
    p_title text,
    p_author_id text,
    p_description text,
    p_created_date timestamp,
    p_metadata1 text,
    p_metadata2 text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM clue_collection
        WHERE id = p_collection_id
    ) THEN
        INSERT INTO clue_collection (
            id,
            puzzle_id,
            title,
            author_id,
            "description",
            created_date,
            metadata1,
            metadata2
        )
        VALUES (
            p_collection_id,
            p_puzzle_id,
            p_title,
            p_author_id,
            p_description,
            p_created_date,
            p_metadata1,
            p_metadata2
        );
    END IF;
END;
$$;
