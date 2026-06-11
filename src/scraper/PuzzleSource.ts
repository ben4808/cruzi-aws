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
import { BEQSource } from '../sources/BEQ';
import { CroceSource } from '../sources/Croce';
import { DailyCommuterSource } from '../sources/DailyCommuter';
import { BestCrosswordsSource } from '../sources/BestCrosswords';
import { PennyDellSource } from '../sources/PennyDell';
import { PennyDellSundaySource } from '../sources/PennyDellSunday';
import { JosephSource } from '../sources/Joseph';
import { ShefferSource } from '../sources/Sheffer';
import { PremierSource } from '../sources/Premier';
import { JonesinSource } from '../sources/Jonesin';

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
  Joseph: new JosephSource(),
  Sheffer: new ShefferSource(),
  DailyCommuter: new DailyCommuterSource(),
  BestCrosswords: new BestCrosswordsSource(),
  Premier: new PremierSource(),
  Jonesin: new JonesinSource(),
  PennyDell: new PennyDellSource(),
  PennyDellSunday: new PennyDellSundaySource(),
  BEQ: new BEQSource(),
  Croce: new CroceSource(),
} as const;
