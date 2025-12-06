import { NewsdaySource } from "../sources/Newsday";
import { NYTSource } from "../sources/NYT";
import { WSJSource } from "../sources/WSJ";
import { Puzzle } from "./Puzzle";

export interface PuzzleSource {
  id: string;
  name: string;
  getPuzzle: (date: Date) => Promise<Puzzle>;
}

export const PuzzleSources = {
  NYT: new NYTSource(),
  Newsday: new NewsdaySource(),
  WSJ: new WSJSource(),
  LAT: null,
  USA: null,
  AVClub: null,
  Universal: null,
  Indie: null,
  Merl: null, // Merl Reagle
  Fireball: null, // Brendan Emmett Quigley
  CrosswordClub: null, // Crossword Club
} as const;
