import { crosswordFamiliarityGenerator } from './crosswordFamiliarityGenerator';
import { crosswordQualityGenerator } from './crosswordQualityGenerator';
import { runTasks } from './crosswordScraper';
import { entryInfoGenerator } from './entryInfoGenerator';
import { exampleSentenceGenerator } from './exampleSentenceGenerator';

//entryInfoGenerator()
//  .then(() => console.log("Entry info generator completed successfully."))
//  .catch(error => console.error("Error in entry info generator: ", error));

//exampleSentenceGenerator()
//  .then(() => console.log("Example sentence generator completed successfully."))
//  .catch(error => console.error("Error in example sentence generator: ", error));

// runTasks()
//   .then(() => console.log("Crossword loading tasks completed successfully."))
//   .catch(error => console.error("Error in crossword loading tasks: ", error));

// crosswordFamiliarityGenerator()
//   .then(() => console.log("Crossword familiarity generator completed successfully."))
//   .catch(error => console.error("Error in crossword familiarity generator: ", error));

crosswordQualityGenerator()
  .then(() => console.log("Crossword quality generator completed successfully."))
  .catch(error => console.error("Error in crossword quality generator: ", error));
