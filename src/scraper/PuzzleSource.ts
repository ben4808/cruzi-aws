import { ScrapedPuzzle } from 'cruzi-models';
import { NewsdaySource } from '../sources/Newsday';
import { NYTSource } from '../sources/NYT';
import { WSJSource } from '../sources/WSJ';
import { LATSource } from '../sources/LAT';
import { UniversalSource } from '../sources/Universal';
import { WashingtonPostSource } from '../sources/WashingtonPost';
import { UniversalSundaySource } from '../sources/UniversalSunday';
import { USATodaySource } from '../sources/USAToday';
import { NewYorkerSource } from '../sources/NewYorker';

export interface PuzzleSource {
  id: string;
  name: string;
  getPuzzle: (date: Date) => Promise<ScrapedPuzzle | null>;
}

export const PuzzleSources = {
  NYT: new NYTSource(),
  Newsday: new NewsdaySource(),
  WSJ: new WSJSource(),
  LAT: new LATSource(),
  Universal: new UniversalSource(),
  UniversalSunday: new UniversalSundaySource(),
  USAToday: new USATodaySource(),
  NewYorker: new NewYorkerSource(),
  WashingtonPost: new WashingtonPostSource(),
} as const;
