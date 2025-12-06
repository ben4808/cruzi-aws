CREATE OR REPLACE FUNCTION _process_answers (
    p_translate_results jsonb,
    p_answer_type text,    -- e.g., 'natural_answers', 'colloquial_answers'
    p_lang_type text       -- e.g., 'translated_lang', 'original_lang'
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- Insert into translated_entry
    INSERT INTO translated_entry (clue_id, "entry", lang, display_text, source_ai)
    SELECT
        (trans->>'clue_id')::text,
        s.allcaps_answer,
        (trans->>p_lang_type)::text, -- Use dynamic language field
        s.display_answer,
        (trans->>'source_ai')::text
    FROM
        jsonb_array_elements(p_translate_results) AS trans
    CROSS JOIN LATERAL
        string_to_array((trans->>p_answer_type)::text, ';') AS answers_array
    CROSS JOIN LATERAL
        (
            SELECT
                answers_array[i] AS allcaps_answer,
                answers_array[i+1] AS display_answer
            FROM
                generate_series(1, array_length(answers_array, 1), 2) AS i
            WHERE
                i + 1 <= array_length(answers_array, 1)
        ) AS s
    ON CONFLICT (clue_id, "entry", lang, source_ai) DO NOTHING;

    -- Insert into "entry" table
    INSERT INTO "entry" ("entry", lang, "length", "display_text")
    SELECT
        s.allcaps_answer,
        (trans->>p_lang_type)::text, -- Use dynamic language field
        LENGTH(s.allcaps_answer),
        s.display_answer
    FROM
        jsonb_array_elements(p_translate_results) AS trans
    CROSS JOIN LATERAL
        string_to_array((trans->>p_answer_type)::text, ';') AS answers_array
    CROSS JOIN LATERAL
        (
            SELECT
                answers_array[i] AS allcaps_answer,
                answers_array[i+1] AS display_answer
            FROM
                generate_series(1, array_length(answers_array, 1), 2) AS i
            WHERE
                i + 1 <= array_length(answers_array, 1)
        ) AS s
    ON CONFLICT ("entry", lang) DO NOTHING;
END;
$$;
