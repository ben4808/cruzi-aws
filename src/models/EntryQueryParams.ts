import { EntryFilter } from "./EntryFilter";

export interface EntryQueryParams {
    query?: string; 
    lang?: string;
    minFamiliarityScore?: number;
    maxFamiliarityScore?: number;
    minQualityScore?: number;
    maxQualityScore?: number;
    filters?: EntryFilter[];
};
