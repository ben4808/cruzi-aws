export interface TranslateResult {
  clueId: string,
  originalLang: string,
  translatedLang: string,
  literalTranslation: string,
  naturalTranslation: string,
  naturalAnswers: string[],
  colloquialAnswers: string[],
  alternativeEnglishAnswers: string[],
  sourceAI: string,
}
