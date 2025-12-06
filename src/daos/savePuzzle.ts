import { sqlQuery } from "./postgres";
import { Puzzle } from "../models/Puzzle";
import { generateId } from "../lib/utils";

const savePuzzle = async (puzzle: Puzzle) => {
    puzzle.id = puzzle.id || generateId();

    await sqlQuery(true, "add_puzzle", [
        {name: "p_puzzle_id", value: puzzle.id},
        {name: "p_publication_id", value: puzzle.publication || ""},
        {name: "p_date", value: puzzle.date},
        {name: "p_author", value: puzzle.authors?.join(", ") || ""},
        {name: "p_title", value: puzzle.title},
        {name: "p_copyright", value: puzzle.copyright || ""},
        {name: "p_notes", value: puzzle.notes || ""},
        {name: "p_width", value: puzzle.width},
        {name: "p_height", value: puzzle.height},
        {name: "p_source_link", value: puzzle.sourceLink || ""},
    ]);
};

export default savePuzzle;
