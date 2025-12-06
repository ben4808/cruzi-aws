import { sqlQuery } from "./postgres";
import { TranslateResult } from "../models/TranslateResult";
import { entryToAllCaps, zipArraysFlat } from "../lib/utils";

const addTranslateResults = async (
    translatedResults: TranslateResult[]
) => {
    let translationsValue = translatedResults.map(result => {
        return {
            clue_id: result.clueId,
            original_lang: result.originalLang,
            translated_lang: result.translatedLang,
            literal_translation: result.literalTranslation,
            natural_translation: result.naturalTranslation,
            natural_answers: result.naturalAnswers[0] === "(None)" ? [] :
                zipArraysFlat(result.naturalAnswers.map(x => entryToAllCaps(x)), result.naturalAnswers).join(";"),
            colloquial_answers: result.colloquialAnswers[0] === "(None)" ? [] :
                zipArraysFlat(result.colloquialAnswers.map(x => entryToAllCaps(x)), result.colloquialAnswers).join(";"),
            alternative_english_answers: result.alternativeEnglishAnswers[0] === "(None)" ? [] :
                zipArraysFlat(result.alternativeEnglishAnswers.map(x => entryToAllCaps(x)), result.alternativeEnglishAnswers).join(";"),
            source_ai: result.sourceAI,
        };
    });

    await sqlQuery(true, "add_translate_results", [
        {name: "p_translate_results", value: translationsValue},
    ]);
};

export default addTranslateResults;
