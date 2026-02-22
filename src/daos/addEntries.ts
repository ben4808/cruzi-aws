import { sqlQuery } from "./postgres";
import { Entry } from "../models/Entry";

const addEntries = async (entries: Entry[]) => {
    const payload = entries.map((e) => ({
        entry: e.entry,
        lang: e.lang,
        rootEntry: e.rootEntry ?? undefined,
        displayText: e.displayText ?? undefined,
        entryType: e.entryType ?? undefined,
        familiarityScore: e.familiarityScore ?? undefined,
        qualityScore: e.qualityScore ?? undefined,
        loadingStatus: e.loadingStatus ?? undefined,
    }));
    await sqlQuery(true, "add_entries", [{ name: "p_entries", value: payload }]);
};

export default addEntries;
