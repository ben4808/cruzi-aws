CREATE OR REPLACE FUNCTION add_familiarity_quality_scores (
    p_scores jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert entry scores
    INSERT INTO entry_score ("entry", lang, familiarity_score, quality_score, source_ai)
    SELECT
        (e->>'entry')::text,
        (e->>'lang')::text,
        (e->>'familiarity_score')::integer,
        (e->>'quality_score')::integer,
        (e->>'source_ai')::text
    FROM jsonb_array_elements(p_scores) AS e
    ON CONFLICT ("entry", lang) DO UPDATE
    SET familiarity_score = EXCLUDED.familiarity_score,
        quality_score = EXCLUDED.quality_score,
        source_ai = EXCLUDED.source_ai;

    WITH avg_scores AS (
        SELECT
            es.entry,
            es.lang,
            CAST(ROUND(AVG(es.familiarity_score)) AS INTEGER) AS avg_familiarity_score,
            CAST(ROUND(AVG(es.quality_score)) AS INTEGER) AS avg_quality_score
        FROM entry_score es
        -- Join with the unnested JSON array to filter for relevant entries
        JOIN jsonb_array_elements(p_scores) AS p ON es.entry = (p->>'entry')::text AND es.lang = (p->>'lang')::text
        GROUP BY es.entry, es.lang
    )
    UPDATE entry e
    SET
        familiarity_score = COALESCE(a.avg_familiarity_score, e.familiarity_score),
        quality_score = COALESCE(a.avg_quality_score, e.quality_score)
    FROM jsonb_array_elements(p_scores) AS p
    LEFT JOIN avg_scores a ON (p->>'entry')::text = a.entry AND (p->>'lang')::text = a.lang
    WHERE e.entry = (p->>'entry')::text
    AND e.lang = (p->>'lang')::text;
END;
$$;
