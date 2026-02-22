import { sqlQuery } from "./postgres";
import { Clue } from "../models/Clue";
import { generateId } from "../lib/utils";

/**
 * Payload shape for add_clues_to_collection(clues_data jsonb).
 * Each element is inserted into clue and collection__clue; collection_id is read from the first element.
 */
interface CluesDataElement {
    collection_id: string;
    id: string;
    entry: string;
    lang: string;
    custom_clue: string | null;
    custom_display_text: string | null;
    source: string | null;
}

const addCluesToCollection = async (collectionId: string, lang: string, clues: Clue[]) => {
    if (clues.length === 0) return;

    const cluesData: CluesDataElement[] = clues.map((clue) => {
        return {
            collection_id: collectionId,
            id: clue.id ?? generateId(),
            entry: clue.entry?.entry ?? "",
            lang,
            custom_clue: clue.customClue ?? null,
            custom_display_text: clue.customDisplayText ?? null,
            source: clue.source ?? null,
        };
    }).filter(x => x.entry.length > 0);

    await sqlQuery(true, "add_clues_to_collection", [
        { name: "clues_data", value: cluesData },
    ]);
};

export default addCluesToCollection;
