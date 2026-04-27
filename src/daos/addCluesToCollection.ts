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
    order: number;
    entry: string;
    lang: string;
    sense_id: string | null;
    custom_clue: string | null;
    custom_display_text: string | null;
    source: string | null;
    metadata1: string | null;
    metadata2: string | null;
}

const addCluesToCollection = async (collectionId: string, clues: Clue[]) => {
    if (clues.length === 0) return;

    const cluesData: CluesDataElement[] = clues.map((clue, index) => {
        return {
            collection_id: collectionId,
            id: clue.id ?? generateId(),
            order: index,
            entry: clue.entry?.entry ?? "",
            lang: clue.lang ?? "en",
            sense_id: clue.sense?.id ?? null,
            custom_clue: clue.customClue ?? null,
            custom_display_text: clue.customDisplayText ?? null,
            source: null,
            metadata1: null,
            metadata2: null,
        };
    }).filter(x => x.entry.length > 0);

    await sqlQuery(true, "add_clues_to_collection", [
        { name: "clues_data", value: cluesData },
    ]);
};

export default addCluesToCollection;
