import fs from 'fs';
import getExampleSentenceQueueTop10 from './daos/getExampleSentenceQueueTop10';
import addExampleSentences from './daos/addExampleSentences';
import { GeminiAiProvider } from './ai/gemini';
import { ExampleSentence } from './models/ExampleSentence';

/**
This script should be written in Node.js/TypeScript.

Tasks:
1. Query the database for the top 10 entries in the example_sentence_queue table.
  - Use DAO function get_example_sentence_queue_top_10()
  - Entries should be removed from the queue after being selected.
  - Output will be in the following structure:
  [
    {
      sense_id: string,
      entry: string,
      display_text: string,
      lang: string,
      sense_summary: string,
    },
    ...
  ]
2. Using the prompt in example_sentences_prompt.txt, send a request to the Gemini 2.5 API to generate example sentences for the sense.
3. Update the database with the example sentences returned from the API.
  - Use the DAO function add_example_sentences(sense_id: string, example_sentences: ExampleSentence[])
  - The status of the entry should be updated. If everything was successful, the status should be set to 'Ready'. If there was an error,
    the status should be set to 'Error'.
 */

const geminiProvider = new GeminiAiProvider();

async function loadExampleSentencesPromptAsync(): Promise<string> {
  try {
    // In Lambda environment, files are relative to the handler location in dist/
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const promptPath = isLambda ? './ai/example_sentences_prompt.txt' : './src/ai/example_sentences_prompt.txt';
    const content: string = await fs.promises.readFile(promptPath, 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading example sentences prompt file:', err);
    throw err;
  }
}

interface ParsedExampleSentences {
  wordPhrase: string;
  sentences: Array<{
    english: string;
    spanish: string;
  }>;
}

function parseExampleSentencesBatchResponse(response: string): ParsedExampleSentences[] | null {
  const lines = response.split('\n');

  // Group lines into blocks separated by blank lines
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }

  // Add the last block if it exists
  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const parsedResults: ParsedExampleSentences[] = [];

  for (const block of blocks) {
    // Filter out empty lines within the block
    const filteredLines = block.filter(line => line.trim() !== '');

    if (filteredLines.length === 0) {
      continue;
    }

    // First line should be the word/phrase
    const wordPhrase = filteredLines[0].trim();

    const sentences: Array<{ english: string; spanish: string }> = [];

    // Parse sentences (3 sentences, each with English and Spanish)
    for (let i = 1; i < filteredLines.length; i += 2) {
      if (i + 1 < filteredLines.length) {
        const english = filteredLines[i].trim();
        const spanish = filteredLines[i + 1].trim();
        sentences.push({ english, spanish });
      }
    }

    // We expect exactly 3 sentences
    if (sentences.length !== 3) {
      console.warn(`Expected 3 sentences but got ${sentences.length} for ${wordPhrase}`);
      return null;
    }

    parsedResults.push({
      wordPhrase,
      sentences
    });
  }

  return parsedResults.length > 0 ? parsedResults : null;
}

function createExampleSentencesFromParsedData(parsedData: ParsedExampleSentences): ExampleSentence[] {
  return parsedData.sentences.map(sentence => ({
    senseId: '', // Will be set when saving
    translations: new Map([
      ['en', sentence.english],
      ['es', sentence.spanish]
    ])
  }));
}

export async function exampleSentenceGenerator(): Promise<void> {
  try {
    console.log('Starting example sentence generation...');

    // Step 1: Get top 10 entries from queue
    const queueItems = await getExampleSentenceQueueTop10();
    console.log(`Processing ${queueItems.length} senses from queue`);

    if (queueItems.length === 0) {
      console.log('No senses in queue');
      return;
    }

    // Load the example sentences prompt template
    const promptTemplate = await loadExampleSentencesPromptAsync();

    // Process senses in batches of 5
    for (let i = 0; i < queueItems.length; i += 5) {
      const batch = queueItems.slice(i, i + 5);
      console.log(`Processing batch of ${batch.length} senses (batch starting at index ${i})`);

      try {
        // Step 2: Create prompt for this batch of senses
        const wordPhraseEntries = batch.map(item =>
          `${item.display_text} (lang: ${item.lang}, sense: ${item.sense_summary})`
        ).join('\n');

        let prompt = promptTemplate
          .replace('[[WORDS AND PHRASES]]', wordPhraseEntries);

        // Step 3: Call Gemini API
        const aiResponse = await geminiProvider.generateResultsAsync(prompt);
        console.log(`AI response for batch:`, aiResponse);

        // Step 4: Parse the response for all items in batch
        const parsedBatchData = parseExampleSentencesBatchResponse(aiResponse);

        if (!parsedBatchData || parsedBatchData.length !== batch.length) {
          console.warn(`Failed to parse AI response for batch - expected ${batch.length} items, got ${parsedBatchData?.length || 0}`);
          continue;
        }

        // Step 5: Process each item in the batch
        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          const parsedData = parsedBatchData[j];

          if (!parsedData) {
            console.warn(`Failed to parse data for sense ${item.sense_id} in batch`);
            continue;
          }

          console.log(`Parsed ${parsedData.sentences.length} example sentences for ${item.entry}`);

          // Step 6: Convert parsed data to ExampleSentence objects
          const exampleSentences: ExampleSentence[] = createExampleSentencesFromParsedData(parsedData);

          // Step 7: Save example sentences to database
          await addExampleSentences(item.sense_id, exampleSentences);
          console.log(`Saved ${exampleSentences.length} example sentences for sense ${item.sense_id}`);
        }

      } catch (error) {
        console.error(`Error processing batch starting at index ${i}:`, error);
        // Continue processing other batches even if one fails
      }
    }

    console.log('Example sentence generation completed');

  } catch (error) {
    console.error('Fatal error in exampleSentenceGenerator:', error);
    throw error;
  }
}