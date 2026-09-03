import { allExploredLoader } from './allExploredLoader';
import { crosswordFamiliarityGenerator } from './crosswordFamiliarityGenerator';
import { crosswordQualityGenerator } from './crosswordQualityGenerator';
import { entryInfoGenerator } from './entryInfoGenerator';
import { exampleSentenceGenerator } from './exampleSentenceGenerator';
import { familiarityGenerator } from './familiarityGenerator';
import { qualityGenerator } from './qualityGenerator';
import { idiomacityGenerator } from './idiomacityGenerator';
import { idiomacityGeneratorRound2 } from './idiomacityGeneratorRound2';
import { scrabbleLoader } from './scrabbleLoader';
import { displayNameFixer } from './displayNameFixer';
import { accentFixer } from './accentFixer';
import { phraseGenerator } from './phraseGenerator';
import { senseFamiliarityGenerator } from './senseFamiliarityGenerator';
import { spokenFamiliarityGenerator } from './spokenFamiliarityGenerator';
import { massNounFixer } from './massNounFixer';
import { exampleSentenceImprover } from './exampleSentenceImprover';
import { unityGenerator } from './unityGenerator';
import { entryParser } from './entryParser';
import { entryImprover } from './entryImprover';
import { CursorAiProvider } from './ai/cursor';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { strictDomainNames } from './strictDomainNames';
import { phraseGeneratorMiner } from './phraseGeneratorMiner';
import { shortPhraseGenerator } from './shortPhraseGenerator';
import { sensesGenerator } from './sensesGenerator';

const aiProvider = new CursorAiProvider(
  'grok-4.6',
);

(async () => {
  const steps = [
    { name: "Entry parser", run: () => entryParser(aiProvider, 600, 10) },
    { name: "Unity generator", run: () => unityGenerator(aiProvider, 600, 10) },
    { name: "Familiarity generator", run: () => familiarityGenerator(aiProvider, 600, 10) },
    { name: "Quality generator", run: () => qualityGenerator(aiProvider, 600, 10) },
  ];

  for (const step of steps) {
    try {
      await step.run();
      console.log(`${step.name} completed successfully.`);
    } catch (error) {
      console.error(`Error in ${step.name.toLowerCase()}: `, error);
    }
  }
})();

// shortPhraseGenerator(aiProvider, 5, 500, 10, "VI___")
//   .then(() => console.log("Short phrase generator completed successfully."))
//   .catch(error => console.error("Error in short phrase generator: ", error));

// sensesGenerator(aiProvider, 50, 10, 'en', 1)
//   .then(() => console.log("Senses generator completed successfully."))
//   .catch(error => console.error("Error in senses generator: ", error));

// entryInfoGenerator()
//  .then(() => console.log("Entry info generator completed successfully."))
//  .catch(error => console.error("Error in entry info generator: ", error));

// exampleSentenceGenerator()
//  .then(() => console.log("Example sentence generator completed successfully."))
//  .catch(error => console.error("Error in example sentence generator: ", error));

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

// scrabbleLoader()
//   .then(() => console.log("Scrabble loader completed successfully."))
//   .catch(error => console.error("Error in scrabble loader: ", error));

// displayNameFixer()
//   .then(() => console.log("Display name fixer completed successfully."))
//   .catch(error => console.error("Error in display name fixer: ", error));

// phraseGenerator(aiProvider, 500, 10)
//   .then(() => console.log("Phrase generator completed successfully."))
//   .catch(error => console.error("Error in phrase generator: ", error));

// senseFamiliarityGenerator()
//   .then(() => console.log("Sense familiarity generator completed successfully."))
//   .catch(error => console.error("Error in sense familiarity generator: ", error));

// massNounFixer()
//   .then(() => console.log("Mass noun fixer completed successfully."))
//   .catch(error => console.error("Error in mass noun fixer: ", error));

// exampleSentenceImprover()
//   .then(() => console.log("Example sentence improver completed successfully."))
//   .catch(error => console.error("Error in example sentence improver: ", error));

// entryImprover(aiProvider, 1000, 10)
//   .then(() => console.log("Entry improver completed successfully."))
//   .catch(error => console.error("Error in entry improver: ", error));

// strictDomainNames()
//   .then(() => console.log("Strict domain names completed successfully."))
//   .catch(error => console.error("Error in strict domain names: ", error));

// spokenFamiliarityGenerator()
//   .then(() => console.log("Spoken familiarity generator completed successfully."))
//   .catch(error => console.error("Error in spoken familiarity generator: ", error));

// phraseGeneratorMiner("C:\\Users\\ben_z\\Desktop\\about_phrases.txt")
//   .then(() => console.log("Phrase generator miner completed successfully."))
//   .catch(error => console.error("Error in phrase generator miner: ", error));

// accentFixer()
//   .then(() => console.log("Accent fixer completed successfully."))
//   .catch(error => console.error("Error in accent fixer: ", error));
