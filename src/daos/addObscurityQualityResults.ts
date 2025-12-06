import { sqlQuery } from "./postgres";
import { Entry } from "../models/Entry";

const addObscurityQualityResults = async (entries: Entry[], sourceAI: string) => {
    let obscurityQualityValue = entries.map(entry => {
        return {
            entry: entry.entry,
            lang: entry.lang,
            display_text: entry.displayText || "",
            entry_type: entry.entryType || "",
            obscurity_score: (entry as any).obscurityScore || entry.familiarityScore || 0, // Entry interface doesn't have obscurityScore
            quality_score: (entry as any).qualityScore || entry.qualityScore || 0,
            source_ai: sourceAI,
        };
    });

    await sqlQuery(true, "add_obscurity_quality_scores", [
        {name: "p_scores", value: obscurityQualityValue},
    ]);
};

export default addObscurityQualityResults;
