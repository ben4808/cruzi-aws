import { arrayToMap, batchArray, entryToAllCaps } from "../lib/utils";
import { Clue } from "../models/Clue";
import { Entry } from "../models/Entry";
import { ObscurityResult } from "../models/ObscurityResult";
import { QualityResult } from "../models/QualityResult";
import { TranslateResult } from "../models/TranslateResult";
import { IAiProvider } from "./IAiProvider";
import fs from 'fs';

export async function getTranslateResults(
  provider: IAiProvider, 
  clues: Clue[], 
  originalLang: string,
  translatedLang: string,
  mockData: boolean
): Promise<TranslateResult[]> {
  let results = [] as TranslateResult[];
  let prompt = await loadTranslatePromptAsync();
  let clueMap = arrayToMap(clues, clue => clue.entry.get(clue.lang)!.entry);

  try {
    let batches = batchArray(clues, 40);

    for (let batch of batches) {
      let promptData = batch.map(clue => `${clue.clue} : ${clue.entry.get(clue.lang)!.entry}`).join('\n');
      let batchPrompt = prompt.replace('[[DATA]]', promptData);

      let resultText = "";
      if (mockData)
        resultText = await getSampleTranslateResultText();
      else
        resultText = await provider.generateResultsAsync(batchPrompt);

      const parsed = parseTranslateResponse(resultText);

      for (let i=0; i < parsed.length; i++) {
        const clue = clueMap.get(parsed[i].entry)!;
        results.push(({
          clueId: clue.id,
          originalLang: originalLang,
          translatedLang: translatedLang,
          literalTranslation: parsed[i].literalTranslation,
          naturalTranslation: parsed[i].naturalTranslation,
          naturalAnswers: parsed[i].naturalAnswers,
          colloquialAnswers: parsed[i].colloquialAnswers,
          alternativeEnglishAnswers: parsed[i].alternativeEnglishAnswers,
          sourceAI: provider.sourceAI,
        }) as TranslateResult);
      }

      if (mockData) break; // For testing, break after first batch
    }
  } catch (error) {
    console.error('Error:', error);
  }

  return results;
}

export async function loadTranslatePromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/translate_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

let getSampleTranslateResultText = async (): Promise<string> => {
  try {
    const content: string = await fs.promises.readFile('./src/ai/sample_translate_response.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export const parseTranslateResponse = (response: string): any[] => {
  const results: any[] = [];
  const lines = response.split('\n').filter(line => line.trim() !== '');

  for (let i = 0; i < lines.length; i+=6) {
    const parts = lines.slice(i, i + 6);
    results.push({
      entry: entryToAllCaps(parts[0].split(':').at(-1)!.trim()),
      literalTranslation: parts[1].split(':').slice(1).join(':').trim(),
      naturalTranslation: parts[2].split(':').slice(1).join(':').trim(),
      naturalAnswers: parts[3].split(':').slice(1).join(':').trim().split(';').map(answer => answer.trim()),
      colloquialAnswers: parts[4].split(':').slice(1).join(':').trim().split(';').map(answer => answer.trim()),
      alternativeEnglishAnswers: parts[5].split(':').slice(1).join(':').trim().split(';').map(answer => answer.trim()),
    });
  }

  return results;
}

export async function getObscurityResults(
  provider: IAiProvider, 
  entries: Entry[], 
  lang: string,
  mockData: boolean
): Promise<ObscurityResult[]> {
  let results = [] as ObscurityResult[];
  let prompt = await loadObscurityPromptAsync();
  let entryMap = arrayToMap(entries, entry => entry.entry);

  try {
    let batches = batchArray(entries, 40) as Entry[][];

    for (let batch of batches) {
      let batchNumber = Math.random().toString(36).substring(2, 5);
      console.log(`Obscurity batch ${batchNumber}: `, batch.map(entry => entry.entry).join(', '));
      let promptData = batch.map(entry => entry.entry).join('\n');
      let batchPrompt = prompt.replace('[[DATA]]', promptData);

      let resultText = "";
      if (mockData)
        resultText = await getSampleObscurityResultText();
      else
        resultText = await provider.generateResultsAsync(batchPrompt);

      const parsed = parseObscurityResponse(resultText);

      for (let i=0; i < parsed.length; i++) {
        const entry = entryMap.get(parsed[i].entry)!;
        if (!entry) {
          console.warn(`Entry not found for obscurity result batch ${batchNumber}: ${parsed[i].entry}`);
          continue;
        }

        results.push(({
          entry: entry.entry,
          lang: lang,
          displayText: parsed[i].displayText,
          entryType: parsed[i].entryType,
          obscurityScore: parsed[i].obscurityScore,
          sourceAI: provider.sourceAI,
        }) as ObscurityResult);
      }

      if (mockData) break; // For testing, break after first batch
    }
  } catch (error) {
    console.error('Error:', error);
  }

  return results;
}

let getSampleObscurityResultText = async (): Promise<string> => {
  try {
    const content: string = await fs.promises.readFile('./src/ai/sample_obscurity_response.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export async function loadObscurityPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/obscurity_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export const parseObscurityResponse = (response: string): any[] => {
  const results: any[] = [];
  const lines = response.split('\n').filter(line => line.trim() !== '');

  for (let line of lines) {
    let parts = line.split(' : ').map(part => part.trim());
    results.push({
      entry: parts[0],
      displayText: parts[1],
      entryType: parts[2],
      obscurityScore: Math.round(parseFloat(parts[3])*10),
    });
  }

  return results;
}

export async function getQualityResults(
  provider: IAiProvider, 
  entries: Entry[], 
  lang: string,
  mockData: boolean
): Promise<QualityResult[]> {
  let results = [] as QualityResult[];
  let prompt = await loadQualityPromptAsync();
  let entryMap = arrayToMap(entries, entry => entry.entry);

  try {
    let batches = batchArray(entries, 40) as Entry[][];

    for (let batch of batches) {
      let batchNumber = Math.random().toString(36).substring(2, 5);
      console.log(`Quality batch ${batchNumber}: `, batch.map(entry => entry.entry).join(', '));
      let promptData = batch.map(entry => entry.displayText!).join('\n');
      let batchPrompt = prompt.replace('[[DATA]]', promptData);
      
      let resultText = "";
      if (mockData)
        resultText = await getSampleQualityResultText();
      else
        resultText = await provider.generateResultsAsync(batchPrompt);

      const parsed = parseQualityResponse(resultText);

      for (let i=0; i < parsed.length; i++) {
        const entry = entryMap.get(parsed[i].entry)!;
        if (!entry) {
          console.warn(`Entry not found for quality result batch ${batchNumber}: ${parsed[i].entry}`);
          continue;
        }

        results.push(({
          entry: entry.entry,
          lang: lang,
          qualityScore: parsed[i].qualityScore,
          sourceAI: provider.sourceAI,
        }) as QualityResult);
      }

      if (mockData) break; // For testing, break after first batch
    }
  } catch (error) {
    console.error('Error:', error);
  }

  return results;
}

export async function loadQualityPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/quality_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

let getSampleQualityResultText = async (): Promise<string> => {
  try {
    const content: string = await fs.promises.readFile('./src/ai/sample_quality_response.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export const parseQualityResponse = (response: string): any[] => {
  const results: any[] = [];
  const lines = response.split('\n').filter(line => line.trim() !== '');

  for (let line of lines) {
    let parts = line.split(' : ').map(part => part.trim());
    results.push({
      entry: entryToAllCaps(parts[0]),
      displayText: parts[0],
      qualityScore: Math.round(parseFloat(parts[1])*10),
    });
  }

  return results;
}

