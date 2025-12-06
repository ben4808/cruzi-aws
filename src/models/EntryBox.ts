export interface EntryBox {
    letter: string;
    state: EntryBoxState;
}

export enum EntryBoxState {
    Empty,
    Correct,
    Incorrect,
}
