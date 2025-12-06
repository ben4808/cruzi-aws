import fs from 'fs';
import getEntryInfoQueueTop10 from './daos/getEntryInfoQueueTop10';
import {upsertEntryInfo, getSensesForEntry } from './daos/upsertEntryInfo';
import { addExampleSentenceQueueEntries } from './daos/addExampleSentenceQueueEntry';
import { Sense } from './models/Sense';
import { EntryTranslation } from './models/EntryTranslation';
import { Entry } from './models/Entry';
import { GeminiAiProvider } from './ai/gemini';

const geminiProvider = new GeminiAiProvider();

/**
This script should be written in Node.js/TypeScript.

Tasks:
1. Query the database for the top 10 entries in the entry_info_queue table.
  - Use DAO function get_entry_info_queue_top_10()
  - Entries should be removed from the queue after being selected.
  - Output will be in the following structure (will also have to query for sense summaries and example sentence counts):
  [
    {
      entry: string,
      lang: string,
      existing_sense_summaries: string[],
      example_sentence_count: number,
    },
    ...
  ]
2. Using the prompt in senses_prompt.txt, send a request to the Gemini 2.5 API to generate senses for the entry.
  - Include the summaries of the existing senses for the entry in the prompt.
4. Update the database with the info returned from the API.
  - Use the DAO function upsert_entry_info(entry: string, senses: Sense[])
  - The info should be updated whether or not the senses already existed. If the sense is referenced to an existing
    sense, that sense ID should be conserved.
  - The status of the entry should be updated. If everything was successful, the status should be set to 'Ready'. If there was an error,
    the status should be set to 'Error'. If there were no senses returned, the status should be set to 'Invalid'.
5. For any returned senses, existing or new, that have less than 3 example sentences, add the sense to the example_sentence_queue table.
  - Use the DAO function add_example_sentence_queue_entry(sense_id: string)
 */

async function loadSensesPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/senses_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading senses prompt file:', err);
    throw err;
  }
}

interface ParsedSense {
  partOfSpeech: string;
  commonness: string;
  summary: string;
  definition: string;
  naturalTranslations: string[];
  colloquialTranslations: string[];
  alternativeEnglish: string[];
  correspondsWith?: string;
}

function parseSensesResponse(response: string): ParsedSense[] {
  const senses: ParsedSense[] = [];
  const lines = response.split('\n').filter(line => line.trim() !== '');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Check if this is a sense header line (starts with '(' and contains part of speech)
    if (line.startsWith('(') && line.includes(') ')) {
      const sense: Partial<ParsedSense> = {};

      // Parse header: "(Noun, Primary) Large plant : A large perennial plant..."
      const headerMatch = line.match(/^\(([^,]+),\s*([^)]+)\)\s*([^:]+)\s*:\s*(.+)$/);
      if (headerMatch) {
        sense.partOfSpeech = headerMatch[1].trim();
        sense.commonness = headerMatch[2].trim();
        sense.summary = headerMatch[3].trim();
        sense.definition = headerMatch[4].trim();
      }

      i++; // Move to next line

      // Parse remaining lines for this sense
      while (i < lines.length && !lines[i].trim().startsWith('(')) {
        const currentLine = lines[i].trim();

        if (currentLine.startsWith('Natural:')) {
          sense.naturalTranslations = currentLine.substring('Natural:'.length).trim().split(',').map(t => t.trim());
        } else if (currentLine.startsWith('Colloquial:')) {
          sense.colloquialTranslations = currentLine.substring('Colloquial:'.length).trim().split(',').map(t => t.trim());
        } else if (currentLine.startsWith('Alternate English:')) {
          const altEnglish = currentLine.substring('Alternate English:'.length).trim();
          sense.alternativeEnglish = altEnglish === '(None)' ? [] : altEnglish.split(',').map(t => t.trim());
        } else if (currentLine.startsWith('Corresponds with:')) {
          sense.correspondsWith = currentLine.substring('Corresponds with:'.length).trim();
        }

        i++;
      }

      // Ensure all required fields are present
      if (sense.partOfSpeech && sense.commonness && sense.summary && sense.definition &&
          sense.naturalTranslations && sense.colloquialTranslations && sense.alternativeEnglish) {
        senses.push(sense as ParsedSense);
      }
    } else {
      i++; // Skip non-header lines
    }
  }

  return senses;
}

function createSenseFromParsedData(parsedSense: ParsedSense, lang: string, existingSenseSummaries: string[]): Sense {
  const sense: Sense = {
    partOfSpeech: parsedSense.partOfSpeech,
    commonness: parsedSense.commonness,
    summary: new Map([[lang, parsedSense.summary]]),
    definition: new Map([[lang, parsedSense.definition]]),
    translations: new Map([[lang, {
      naturalTranslations: parsedSense.naturalTranslations.map(t => ({ entry: t, lang: 'es' } as Entry)),
      colloquialTranslations: parsedSense.colloquialTranslations.map(t => ({ entry: t, lang: 'es' } as Entry)),
      alternatives: parsedSense.alternativeEnglish.map(t => ({ entry: t, lang: 'en' } as Entry)),
      source_ai: 'gemini'
    } as EntryTranslation]]),
    sourceAi: 'gemini'
  };

  // Handle corresponds_with for existing sense matching
  if (parsedSense.correspondsWith) {
    // Note: The corresponds_with logic is handled in the stored procedure
    // We need to add this field to the sense data sent to the stored procedure
    (sense as any).corresponds_with = parsedSense.correspondsWith;
  }

  return sense;
}

export async function entryInfoGenerator(): Promise<void> {
  try {
    console.log('Starting entry info generation...');

    // Step 1: Get top 10 entries from queue
    const queueItems = await getEntryInfoQueueTop10();
    console.log(`Processing ${queueItems.length} entries from queue`);

    if (queueItems.length === 0) {
      console.log('No entries in queue');
      return;
    }

    // Load the senses prompt template
    const promptTemplate = await loadSensesPromptAsync();

    // Process each entry
    for (const item of queueItems) {
      try {
        console.log(`Processing entry: ${item.entry} (${item.lang}) - ${item.existing_sense_summaries.length} existing senses`);

        // Step 2: Create prompt with existing sense summaries
        const referenceSenses = item.existing_sense_summaries.length > 0
          ? item.existing_sense_summaries.map(summary => `"${summary}"`).join(', ')
          : '(None)';

        let prompt = promptTemplate
          .replace('[[PHRASE]]', item.entry)
          .replace('[[LANGUAGE CODE]]', item.lang)
          .replace('[[REFERECE SENSES]]', referenceSenses);

        // Step 3: Call Gemini API
        const aiResponse = await geminiProvider.generateResultsAsync(prompt);
        console.log(`AI response for ${item.entry}:`, aiResponse);

        // Step 4: Parse the response
        const parsedSenses = parseSensesResponse(aiResponse);
        console.log(`Parsed ${parsedSenses.length} senses for ${item.entry}`);

        // Step 5: Convert parsed senses to Sense objects
        const senses: Sense[] = parsedSenses.map(parsedSense =>
          createSenseFromParsedData(parsedSense, item.lang, item.existing_sense_summaries)
        );

        // Step 6: Determine status
        let status: 'Ready' | 'Error' | 'Invalid';
        if (parsedSenses.length === 0) {
          status = 'Invalid';
        } else {
          status = 'Ready';
        }

        // Step 7: Update database with senses
        await upsertEntryInfo(item.entry, item.lang, senses, status);
        console.log(`Updated database for ${item.entry} with status: ${status}`);

        // Step 8: Queue senses with less than 3 example sentences
        // Get all senses for this entry (including newly created ones) and check their example sentence counts
        const allSensesForEntry = await getSensesForEntry(item.entry, item.lang);
        const sensesToQueue: string[] = [];

        for (const sense of allSensesForEntry) {
          if (sense.id && (!sense.exampleSentences || sense.exampleSentences.length < 3)) {
            sensesToQueue.push(sense.id);
          }
        }

        if (sensesToQueue.length > 0) {
          await addExampleSentenceQueueEntries(sensesToQueue);
          console.log(`Queued ${sensesToQueue.length} senses for example sentences`);
        }

      } catch (error) {
        console.error(`Error processing entry ${item.entry}:`, error);

        // Update status to Error
        try {
          await upsertEntryInfo(item.entry, item.lang, [], 'Error');
        } catch (dbError) {
          console.error(`Failed to update error status for ${item.entry}:`, dbError);
        }
      }
    }

    console.log('Entry info generation completed');

  } catch (error) {
    console.error('Fatal error in entryInfoGenerator:', error);
    throw error;
  }
}
