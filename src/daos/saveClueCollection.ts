import { sqlQuery } from "./postgres";
import { ClueCollection } from "../models/ClueCollection";
import { generateId } from "../lib/utils";

const saveClueCollection = async (clueCollection: ClueCollection) => {
    clueCollection.id = clueCollection.id || generateId();

    await sqlQuery(true, "add_clue_collection", [
        {name: "p_collection_id", value: clueCollection.id},
        {name: "p_puzzle_id", value: clueCollection.puzzle?.id || ""},
        {name: "p_title", value: clueCollection.title},
        {name: "p_author_id", value: clueCollection.creator?.id || ""},
        {name: "p_description", value: clueCollection.description || ""},
        {name: "p_created_date", value: clueCollection.createdDate},
        {name: "p_metadata1", value: clueCollection.metadata1 || ""},
        {name: "p_metadata2", value: clueCollection.metadata2 || ""},
    ]);
};

export default saveClueCollection;
