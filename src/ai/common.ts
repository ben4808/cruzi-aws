import { arrayToMap, batchArray, entryToAllCaps } from "../lib/utils";
import { Entry } from "../models/Entry";
import { FamiliarityResult } from "../models/FamiliarityResult";
import { LanguageNames } from "../models/LanguageNames";
import { QualityResult } from "../models/QualityResult";
import { IAiProvider } from "./IAiProvider";
import fs from 'fs';

export async function getFamiliarityResults(
  provider: IAiProvider, 
  entries: Entry[], 
  lang: string,
  useMockData: boolean
): Promise<FamiliarityResult[]> {
  let results = [] as FamiliarityResult[];
  let prompt = await loadFamiliarityPromptAsync();
  let entryMap = arrayToMap(entries, entry => entry.entry);

  try {
    let batches = batchArray(entries, 40) as Entry[][];

    for (let batch of batches) {
      let batchNumber = Math.random().toString(36).substring(2, 5);
      console.log(`Familiarity batch ${batchNumber}: `, batch.map(entry => entry.entry).join(', '));
      let langName = LanguageNames[lang];
      let batchPrompt = prompt.replace(/\[\[LANG\]\]/g, langName);
      let promptData = batch.map(entry => entry.entry).join('\n');
      batchPrompt = batchPrompt.replace('[[DATA]]', promptData);

      let resultText = "";
      if (useMockData)
        resultText = await getSampleFamiliarityResultText();
      else
        resultText = await provider.generateResultsAsync(batchPrompt);

      const parsed = parseFamiliarityResponse(resultText);

      for (let i=0; i < parsed.length; i++) {
        const entry = entryMap.get(parsed[i].entry)!;
        if (!entry) {
          console.warn(`Entry not found for familiarity result batch ${batchNumber}: ${parsed[i].entry}`);
          continue;
        }

        results.push(({
          entry: entry.entry,
          lang: lang,
          baseForm: parsed[i].baseForm,
          displayText: parsed[i].displayText,
          entryType: parsed[i].entryType,
          familiarityScore: parsed[i].familiarityScore,
          sourceAI: provider.sourceAI,
        }) as FamiliarityResult);
      }

      if (useMockData) break; // For testing, break after first batch
    }
  } catch (error) {
    console.error('Error:', error);
  }

  return results;
}

let getSampleFamiliarityResultText = async (): Promise<string> => {
  try {
    const content: string = await fs.promises.readFile('./src/ai/sample_familiarity_response.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export async function loadFamiliarityPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/familiarity_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export const parseFamiliarityResponse = (response: string): any[] => {
  const results: any[] = [];
  const lines = response.split('\n').filter(line => line.trim() !== '');

  for (let line of lines) {
    let parts = line.split(' : ').map(part => part.trim());
    let baseForm = undefined;
    if (parts[2].includes('Derived Word')) {
      baseForm = parts[2].split(' (')[1].split(')')[0];
      parts[2] = 'Derived Word';
    }
    results.push({
      entry: parts[0],
      baseForm: baseForm,
      displayText: parts[1],
      entryType: parts[2],
      familiarityScore: Math.round(parseFloat(parts[3])*10),
    });
  }

  return results;
}

export async function getQualityResults(
  provider: IAiProvider, 
  entries: Entry[], 
  lang: string,
  useMockData: boolean
): Promise<QualityResult[]> {
  let results = [] as QualityResult[];
  let prompt = await loadQualityPromptAsync();
  let entryMap = arrayToMap(entries, entry => entry.entry);

  try {
    let batches = batchArray(entries, 40) as Entry[][];

    for (let batch of batches) {
      let batchNumber = Math.random().toString(36).substring(2, 5);
      console.log(`Quality batch ${batchNumber}: `, batch.map(entry => entry.entry).join(', '));
      let langName = LanguageNames[lang];
      let batchPrompt = prompt.replace(/\[\[LANG\]\]/g, langName);
      let promptData = batch.map(entry => entry.displayText!).join('\n');
      batchPrompt = batchPrompt.replace('[[DATA]]', promptData);
      
      let resultText = "";
      if (useMockData)
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

      if (useMockData) break; // For testing, break after first batch
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

