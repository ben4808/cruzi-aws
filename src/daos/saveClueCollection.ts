import { sqlQuery } from "./postgres";
import { ClueCollection } from "../models/ClueCollection";
import { generateId } from "../lib/utils";

const saveClueCollection = async (clueCollection: ClueCollection) => {
    clueCollection.id = clueCollection.id || generateId();

    await sqlQuery(true, "add_clue_collection", [
        {name: "p_collection_id", value: clueCollection.id},
        {name: "p_puzzle_id", value: clueCollection.puzzle?.id ?? ""},
        {name: "p_title", value: clueCollection.title},
        {name: "p_lang", value: clueCollection.lang || "en"},
        {name: "p_author", value: clueCollection.author ?? ""},
        {name: "p_creator_id", value: clueCollection.creator?.id ?? ""},
        {name: "p_description", value: clueCollection.description ?? ""},
        {name: "p_is_private", value: clueCollection.isPrivate ?? false},
        {name: "p_created_date", value: clueCollection.createdDate ?? new Date()},
        {name: "p_modified_date", value: clueCollection.modifiedDate ?? clueCollection.createdDate ?? new Date()},
        {name: "p_metadata1", value: clueCollection.metadata1 ?? ""},
        {name: "p_metadata2", value: clueCollection.metadata2 ?? ""},
        {name: "p_clue_count", value: clueCollection.clueCount ?? 0},
        {name: "p_source", value: clueCollection.source ?? ""},
    ]);
};

export default saveClueCollection;
