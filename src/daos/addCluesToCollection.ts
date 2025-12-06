import { sqlQuery } from "./postgres";
import { Clue } from "../models/Clue";
import { Entry } from "../models/Entry";
import { generateId } from "../lib/utils";

const addCluesToCollection = async (collectionId: string, clues: Clue[]) => {
    let order = 1;

    let cluesValue = clues.map(clue => {
        clue.id = clue.id || generateId();
        // Note: The Clue interface doesn't include lang, clue, responseTemplate, metadata1 properties
        // This implementation assumes clues have these properties as used in puzzleToClueCollection
        const clueLang = (clue as any).lang || 'en';
        const clueText = (clue as any).clue || clue.customClue || '';
        const responseTemplate = (clue as any).responseTemplate || null;
        const metadata1 = (clue as any).metadata1 || '';
        const source = (clue as any).source || clue.source || null;

        let entry = clue.entry?.get(clueLang);
        return {
            clue_id: clue.id,
            order: order++,
            metadata1: metadata1,
            entry: entry?.entry || "",
            lang: clueLang,
            clue: clueText,
            response_template: responseTemplate,
            source: source,
        };
    });

    await sqlQuery(true, "add_clues_to_collection", [
        {name: "p_collection_id", value: collectionId},
        {name: "p_clues", value: cluesValue},
    ]);

    let entriesValue = clues.map(clue => {
        // Note: The Clue interface doesn't include lang property
        const clueLang = (clue as any).lang || 'en';
        let entry = clue.entry?.get(clueLang);
        if (!entry) return null;

        return {
            entry: entry.entry,
            lang: entry.lang,
            length: (entry as any).length || entry.entry.length, // Entry interface doesn't have length
        };
    }).filter(e => e !== null);

    if (entriesValue.length > 0) {
        await sqlQuery(true, "add_entries", [
            {name: "p_entries", value: entriesValue},
        ]);
    }
};

export default addCluesToCollection;
