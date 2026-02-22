CREATE OR REPLACE FUNCTION add_entries (
    p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO "entry" (
        "entry",
        lang,
        "length",
        root_entry,
        display_text,
        entry_type,
        familiarity_score,
        quality_score,
        loading_status
    )
    SELECT
        (e->>'entry')::text,
        (e->>'lang')::text,
        COALESCE((e->>'length')::integer, length((e->>'entry')::text)),
        NULLIF(trim(e->>'rootEntry'), ''),
        NULLIF(trim(e->>'displayText'), ''),
        NULLIF(trim(e->>'entryType'), ''),
        (e->>'familiarityScore')::integer,
        (e->>'qualityScore')::integer,
        COALESCE(NULLIF(trim(e->>'loadingStatus'), ''), 'Ready')
    FROM jsonb_array_elements(p_entries) AS e
    ON CONFLICT ("entry", lang) DO UPDATE SET
        root_entry = COALESCE(EXCLUDED.root_entry, "entry".root_entry),
        display_text = COALESCE(EXCLUDED.display_text, "entry".display_text),
        entry_type = COALESCE(EXCLUDED.entry_type, "entry".entry_type),
        familiarity_score = COALESCE(EXCLUDED.familiarity_score, "entry".familiarity_score),
        quality_score = COALESCE(EXCLUDED.quality_score, "entry".quality_score),
        loading_status = COALESCE(EXCLUDED.loading_status, "entry".loading_status);
END;
$$;
