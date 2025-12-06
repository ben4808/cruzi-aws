CREATE OR REPLACE FUNCTION add_obscurity_quality_scores (
    p_scores jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert entry scores
    INSERT INTO entry_score ("entry", lang, obscurity_score, quality_score, source_ai)
    SELECT
        (e->>'entry')::text,
        (e->>'lang')::text,
        (e->>'obscurity_score')::integer,
        (e->>'quality_score')::integer,
        (e->>'source_ai')::text
    FROM jsonb_array_elements(p_scores) AS e
    ON CONFLICT ("entry", lang) DO UPDATE
    SET obscurity_score = EXCLUDED.obscurity_score,
        quality_score = EXCLUDED.quality_score,
        source_ai = EXCLUDED.source_ai;

    WITH avg_scores AS (
        SELECT
            es.entry,
            es.lang,
            CAST(ROUND(AVG(es.obscurity_score)) AS INTEGER) AS avg_obscurity_score,
            CAST(ROUND(AVG(es.quality_score)) AS INTEGER) AS avg_quality_score
        FROM entry_score es
        -- Join with the unnested JSON array to filter for relevant entries
        JOIN jsonb_array_elements(p_scores) AS p ON es.entry = (p->>'entry')::text AND es.lang = (p->>'lang')::text
        GROUP BY es.entry, es.lang
    )
    UPDATE entry e
    SET
        display_text = COALESCE((p->>'display_text')::text, e.display_text),
        entry_type = COALESCE((p->>'entry_type')::text, e.entry_type),
        obscurity_score = COALESCE(a.avg_obscurity_score, e.obscurity_score),
        quality_score = COALESCE(a.avg_quality_score, e.quality_score)
    FROM jsonb_array_elements(p_scores) AS p
    LEFT JOIN avg_scores a ON (p->>'entry')::text = a.entry AND (p->>'lang')::text = a.lang
    WHERE e.entry = (p->>'entry')::text
    AND e.lang = (p->>'lang')::text;
END;
$$;
