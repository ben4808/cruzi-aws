import { ScrapedPuzzle } from 'cruzi-models';
import { NewsdaySource } from '../sources/Newsday';
import { NYTSource } from '../sources/NYT';
import { WSJSource } from '../sources/WSJ';

export interface PuzzleSource {
  id: string;
  name: string;
  getPuzzle: (date: Date) => Promise<ScrapedPuzzle>;
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
  Merl: null,
  Fireball: null,
  CrosswordClub: null,
} as const;
