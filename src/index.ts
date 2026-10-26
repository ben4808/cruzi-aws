import { exampleSentenceGenerator } from './exampleSentenceGenerator';
import { familiarityGenerator } from './familiarityGenerator';
import { qualityGenerator } from './qualityGenerator';
import { scrabbleLoader } from './scrabbleLoader';
import { displayNameFixer } from './displayNameFixer';
import { phraseGenerator } from './phraseGenerator';
import { senseFamiliarityGenerator } from './senseFamiliarityGenerator';
import { exampleSentenceImprover } from './exampleSentenceImprover';
import { unityGenerator } from './unityGenerator';
import { entryParser } from './entryParser';
import { entryImprover } from './entryImprover';
import { CursorAiProvider } from './ai/cursor';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { shortPhraseGenerator } from './shortPhraseGenerator';
import { sensesGenerator } from './sensesGenerator';
import { crosswordListExtractor } from './crosswordListExtractor';
import { crosswordProcessor } from './crosswordProcessor';
import { XiaomiAiProvider } from './ai/xiaomi';

const aiProvider = new CursorAiProvider(
  'grok-4.6',
  //'grok-4.7',
  //'claude-haiku-5-5',
  //'claude-sonnet-5-5',
  //'gemini-3.8-flash',
);

// const aiProvider = new XiaomiAiProvider(
//   'mimo-v2.6-pro',
// );

// (async () => {
//   const steps = [
//     //{ name: "Entry parser", run: () => entryParser(aiProvider, 2000, 10) },
//     //{ name: "Unity generator", run: () => unityGenerator(aiProvider, 3000, 10) },
//     { name: "Familiarity generator", run: () => familiarityGenerator(aiProvider, 3000, 10) },
//     //{ name: "Quality generator", run: () => qualityGenerator(aiProvider, 1000, 10) },
//   ];

//   for (const step of steps) {
//     try {
//       await step.run();
//       console.log(`${step.name} completed successfully.`);
//     } catch (error) {
//       console.error(`Error in ${step.name.toLowerCase()}: `, error);
//     }
//   }
// })();

// crosswordProcessor(aiProvider, 10)
//   .then(() => console.log("Crossword processor completed successfully."))
//   .catch(error => console.error("Error in crossword processor: ", error));

crosswordListExtractor(3, 7)
  .then(() => console.log("Crossword list extractor completed successfully."))
  .catch(error => console.error("Error in crossword list extractor: ", error));

// entryParser(aiProvider, 100, 5)
//   .then(() => console.log("Entry parser completed successfully."))
//   .catch(error => console.error("Error in entry parser: ", error));

// phraseGenerator(aiProvider, 1000, 10)
//   .then(() => console.log("Phrase generator completed successfully."))
//   .catch(error => console.error("Error in phrase generator: ", error));

// shortPhraseGenerator(aiProvider, 6, 500, 1, "VI____")
//   .then(() => console.log("Short phrase generator completed successfully."))
//   .catch(error => console.error("Error in short phrase generator: ", error));

// sensesGenerator(aiProvider, 50, 10, 'en', 1)
//   .then(() => console.log("Senses generator completed successfully."))
//   .catch(error => console.error("Error in senses generator: ", error));

// exampleSentenceGenerator()
//  .then(() => console.log("Example sentence generator completed successfully."))
//  .catch(error => console.error("Error in example sentence generator: ", error));

// scrabbleLoader()
//   .then(() => console.log("Scrabble loader completed successfully."))
//   .catch(error => console.error("Error in scrabble loader: ", error));

// displayNameFixer()
//   .then(() => console.log("Display name fixer completed successfully."))
//   .catch(error => console.error("Error in display name fixer: ", error));

// senseFamiliarityGenerator()
//   .then(() => console.log("Sense familiarity generator completed successfully."))
//   .catch(error => console.error("Error in sense familiarity generator: ", error));

// exampleSentenceImprover()
//   .then(() => console.log("Example sentence improver completed successfully."))
//   .catch(error => console.error("Error in example sentence improver: ", error));

// entryImprover(aiProvider, 1000, 10)
//   .then(() => console.log("Entry improver completed successfully."))
//   .catch(error => console.error("Error in entry improver: ", error));

