import { allExploredLoader } from './allExploredLoader';
import { crosswordFamiliarityGenerator } from './crosswordFamiliarityGenerator';
import { crosswordQualityGenerator } from './crosswordQualityGenerator';
import { runTasks } from './crosswordScraper';
import { entryInfoGenerator } from './entryInfoGenerator';
import { exampleSentenceGenerator } from './exampleSentenceGenerator';
import { familiarityGenerator } from './familiarityGenerator';
import { qualityGenerator } from './qualityGenerator';
import { idiomacityGenerator } from './idiomacityGenerator';
import { idiomacityGeneratorRound2 } from './idiomacityGeneratorRound2';
import { scrabbleLoader } from './scrabbleLoader';
import { displayNameFixer } from './displayNameFixer';
import { phraseGenerator } from './phraseGenerator';
import { senseFamiliarityGenerator } from './senseFamiliarityGenerator';

// entryInfoGenerator()
//  .then(() => console.log("Entry info generator completed successfully."))
//  .catch(error => console.error("Error in entry info generator: ", error));

// exampleSentenceGenerator()
//  .then(() => console.log("Example sentence generator completed successfully."))
//  .catch(error => console.error("Error in example sentence generator: ", error));

runTasks()
  .then(() => console.log("Crossword loading tasks completed successfully."))
  .catch(error => console.error("Error in crossword loading tasks: ", error));

// crosswordFamiliarityGenerator()
//   .then(() => console.log("Crossword familiarity generator completed successfully."))
//   .catch(error => console.error("Error in crossword familiarity generator: ", error));

// crosswordQualityGenerator()
//   .then(() => console.log("Crossword quality generator completed successfully."))
//   .catch(error => console.error("Error in crossword quality generator: ", error));

// allExploredLoader()
//   .then(() => console.log("AllExplored loader completed successfully."))
//   .catch(error => console.error("Error in AllExplored loader: ", error));

// idiomacityGenerator()
//   .then(() => console.log("Idiomacity generator completed successfully."))
//   .catch(error => console.error("Error in idiomacity generator: ", error));

// idiomacityGeneratorRound2()
//   .then(() => console.log("Idiomacity generator round 2 completed successfully."))
//   .catch(error => console.error("Error in idiomacity generator round 2: ", error));

// familiarityGenerator()
//   .then(() => console.log("Familiarity generator completed successfully."))
//   .catch(error => console.error("Error in familiarity generator: ", error));

// qualityGenerator()
//   .then(() => console.log("Quality generator completed successfully."))
//   .catch(error => console.error("Error in quality generator: ", error));

// scrabbleLoader()
//   .then(() => console.log("Scrabble loader completed successfully."))
//   .catch(error => console.error("Error in scrabble loader: ", error));

// displayNameFixer()
//   .then(() => console.log("Display name fixer completed successfully."))
//   .catch(error => console.error("Error in display name fixer: ", error));

// phraseGenerator()
//   .then(() => console.log("Phrase generator completed successfully."))
//   .catch(error => console.error("Error in phrase generator: ", error));

// senseFamiliarityGenerator()
//   .then(() => console.log("Sense familiarity generator completed successfully."))
//   .catch(error => console.error("Error in sense familiarity generator: ", error));
  