import { sqlQuery } from "./postgres";
import { Entry } from "../models/Entry";

const addFamiliarityQualityResults = async (entries: Entry[], sourceAI: string) => {
    let familiarityQualityValue = entries.map(entry => {
        return {
            entry: entry.entry,
            lang: entry.lang,
            familiarity_score: entry.avgFamiliarityScore || null,
            quality_score: entry.avgQualityScore || null,
            source_ai: sourceAI,
        };
    });

    await sqlQuery(true, "add_familiarity_quality_scores", [
        {name: "p_scores", value: familiarityQualityValue},
    ]);
};

export default addFamiliarityQualityResults;
