CREATE OR REPLACE FUNCTION add_puzzle (
    p_puzzle_id text,
    p_publication_id text,
    p_date date,
    p_author text,
    p_title text,
    p_copyright text,
    p_notes text,
    p_width integer,
    p_height integer,
    p_source_link text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM puzzle
        WHERE publication_id = p_publication_id
        AND "date" = p_date
        AND title = p_title
    ) THEN
        INSERT INTO puzzle (
            id,
            publication_id,
            "date",
            author,
            title,
            copyright,
            notes,
            width,
            height,
            source_link
        )
        VALUES (
            p_puzzle_id,
            p_publication_id,
            p_date,
            p_author,
            p_title,
            p_copyright,
            p_notes,
            p_width,
            p_height,
            p_source_link
        );
    END IF;
END;
$$;
