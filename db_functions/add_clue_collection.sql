CREATE OR REPLACE FUNCTION add_clue_collection (
    p_collection_id text,
    p_puzzle_id text,
    p_title text,
    p_lang text,
    p_author text,
    p_creator_id text,
    p_description text,
    p_is_private boolean,
    p_created_date timestamp,
    p_modified_date timestamp,
    p_metadata1 text,
    p_metadata2 text,
    p_clue_count integer,
    p_source text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO clue_collection (
        id,
        puzzle_id,
        title,
        lang,
        author,
        creator_id,
        "description",
        is_private,
        created_date,
        modified_date,
        metadata1,
        metadata2,
        clue_count,
        "source"
    )
    VALUES (
        p_collection_id,
        NULLIF(p_puzzle_id, ''),
        p_title,
        p_lang,
        NULLIF(p_author, ''),
        NULLIF(p_creator_id, ''),
        NULLIF(p_description, ''),
        COALESCE(p_is_private, false),
        p_created_date,
        p_modified_date,
        NULLIF(p_metadata1, ''),
        NULLIF(p_metadata2, ''),
        COALESCE(p_clue_count, 0),
        p_source
    )
    ON CONFLICT (id) DO UPDATE SET
        puzzle_id = EXCLUDED.puzzle_id,
        title = EXCLUDED.title,
        lang = EXCLUDED.lang,
        author = EXCLUDED.author,
        creator_id = EXCLUDED.creator_id,
        "description" = EXCLUDED."description",
        is_private = EXCLUDED.is_private,
        created_date = EXCLUDED.created_date,
        modified_date = EXCLUDED.modified_date,
        metadata1 = EXCLUDED.metadata1,
        metadata2 = EXCLUDED.metadata2,
        clue_count = EXCLUDED.clue_count,
        "source" = EXCLUDED.source;
END;
$$;
