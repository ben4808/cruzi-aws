CREATE OR REPLACE FUNCTION upsert_entry_info(
    p_entry_info jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    sense_record jsonb;
    sense_id text;
    entry_name text;
    entry_lang text;
    entry_status text;
BEGIN
    -- Extract parameters from jsonb
    entry_name := (p_entry_info->>'entry')::text;
    entry_lang := (p_entry_info->>'lang')::text;
    entry_status := (p_entry_info->>'status')::text;

    -- Update entry status
    UPDATE "entry"
    SET loading_status = entry_status
    WHERE "entry" = entry_name AND lang = entry_lang;

    -- Process each sense
    FOR sense_record IN SELECT * FROM jsonb_array_elements(p_entry_info->'senses')
    LOOP
        -- Check if sense corresponds to existing sense
        IF sense_record ? 'corresponds_with' AND (sense_record->>'corresponds_with') IS NOT NULL THEN
            -- Find existing sense by summary match
            SELECT s.id INTO sense_id
            FROM sense s
            JOIN sense_translation st ON st.sense_id = s.id
            WHERE s.entry = entry_name
              AND s.lang = entry_lang
              AND st.lang = entry_lang
              AND st.summary = (sense_record->>'corresponds_with')
            LIMIT 1;

            IF sense_id IS NULL THEN
                -- Generate new sense ID if no match found
                sense_id := gen_random_uuid()::text;
            END IF;
        ELSE
            -- Check if sense already has an ID (from the input)
            IF sense_record ? 'id' AND (sense_record->>'id') IS NOT NULL THEN
                sense_id := (sense_record->>'id')::text;
            ELSE
                -- Generate new sense ID
                sense_id := gen_random_uuid()::text;
            END IF;
        END IF;

        -- Insert or update sense
        INSERT INTO sense (
            id,
            "entry",
            lang,
            part_of_speech,
            commonness,
            source_ai
        ) VALUES (
            sense_id,
            entry_name,
            entry_lang,
            (sense_record->>'part_of_speech')::text,
            (sense_record->>'commonness')::text,
            (sense_record->>'source_ai')::text
        )
        ON CONFLICT (id) DO UPDATE SET
            part_of_speech = EXCLUDED.part_of_speech,
            commonness = EXCLUDED.commonness,
            source_ai = EXCLUDED.source_ai;

        -- Insert or update sense translation
        INSERT INTO sense_translation (
            sense_id,
            lang,
            summary,
            "definition"
        ) VALUES (
            sense_id,
            entry_lang,
            (sense_record->>'summary')::text,
            (sense_record->>'definition')::text
        )
        ON CONFLICT (sense_id, lang) DO UPDATE SET
            summary = EXCLUDED.summary,
            "definition" = EXCLUDED."definition";
    END LOOP;
END;
$$;
