import { runTasks } from './crosswordScraper';
import { entryInfoGenerator } from './entryInfoGenerator';

export { entryInfoGenerator };

entryInfoGenerator()
  .then(() => console.log("Entry info generator completed successfully."))
  .catch(error => console.error("Error in entry info generator: ", error));

//runTasks()
//  .then(() => console.log("Crossword loading tasks completed successfully."))
//  .catch(error => console.error("Error in crossword loading tasks: ", error));
