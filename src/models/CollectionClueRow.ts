export interface CollectionClueRow {
    id: string;
    answer: string;
    sense: string;
    clue: string;
    progress: string;
    status: string;
    senses: { sense_id: string; sense_summary: string }[];
}
