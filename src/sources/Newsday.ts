import { PuzzleSource } from "../models/PuzzleSource";
import { Square } from "../models/Square";
import { Puzzle } from "../models/Puzzle";
import { PuzzleEntry } from "../models/PuzzleEntry";
import { generatePuzFile } from "../lib/puzFiles";

export class NewsdaySource implements PuzzleSource {
    public id = "Newsday";
    public name = "Newsday";

    public async getPuzzle(date: Date): Promise<Puzzle> {
        let dateString = `${date.getFullYear().toString().slice(2)}${(date.getMonth()+1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}`;
        let url = `https://brainsonly.com/servlets-newsday-crossword/newsdaycrossword?date=${dateString}`;
        //url = `https://brainsonly.com/servlets-newsday-crossword/newsdaycrossword?date=250611`;
        let weoriginUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);
        let response = await fetch(weoriginUrl); 
        let textResponse = await response.json();
        let content = textResponse.contents as string;

        const lines = content.split('\n').filter(line => line.trim() !== '');
    
        // Parse header information
        const archive = lines[0].trim();
        const title = lines[2].trim().replace(/\d{1,2}\/\d{1,2}\/\d{1,2} /g, "");
        const authorLine = lines[3].replace(", edited by Stanley Newman", "").trim();
        const width = parseInt(lines[4].trim());
        const height = parseInt(lines[5].trim());
        const acrossClueCount = parseInt(lines[6].trim());
        const downClueCount = parseInt(lines[7].trim());
        
        // Parse grid
        const gridLines = lines.slice(8, 8 + height);
        const grid: Square[][] = [];
        let numberCounter = 1;
        let acrossIndexes = [] as string[];
        let downIndexes = [] as string[];
        
        for (let row = 0; row < height; row++) {
            const rowSquares: Square[] = [];
            
            for (let col = 0; col < width; col++) {
                const content = gridLines[row].charAt(col);
                const isBlack = content === '#';
                
                const directions: string[] = [];
                let number: number | undefined;
                
                // Assign number if square starts an across or down clue
                if (!isBlack) {
                    const needsAcrossNumber = (col === 0 || rowSquares[col - 1]?.isBlack);
                    const needsDownNumber = (row === 0 || grid[row - 1]?.[col]?.isBlack);
                    
                    if (needsAcrossNumber || needsDownNumber) {
                        number = numberCounter++;
                        if (needsAcrossNumber) {
                            directions.push('across');
                            acrossIndexes.push(`${number}A`);
                        }
                        if (needsDownNumber) {
                            directions.push('down');
                            downIndexes.push(`${number}D`);
                        }
                    }
                }
                
                rowSquares.push({
                    row,
                    col,
                    number,
                    directions,
                    isBlack,
                    content: isBlack ? '' : content,
                    isCircled: false
                });
            }
            grid.push(rowSquares);
        }
        
        // Parse clues and create entries
        const entries = new Map<string, PuzzleEntry>();
        const clueLines = lines.slice(8 + height);

        for (let i = 0; i < (acrossClueCount + downClueCount); i++) {
          const clueLine = clueLines[i].trim();
          const index = i < acrossClueCount ? acrossIndexes[i] : downIndexes[i - acrossClueCount];
          entries.set(index, {
              index: index,
              clue: clueLine,
              entry: '', // Placeholder, will be filled later
          });
        }
        
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const square = grid[row][col];
                if (square.number) {
                    const number = square.number;
                    
                    // Handle across clue
                    if (square.directions.includes('across')) {
                        let answer = '';
                        let c = col;
                        while (c < width && !grid[row][c].isBlack) {
                            answer += grid[row][c].content;
                            c++;
                        }
                        let index = `${number}A`;
                        entries.get(index)!.entry = answer; // Fill the entry for across clue
                    }
                    
                    // Handle down clue
                    if (square.directions.includes('down')) {
                        let answer = '';
                        let r = row;
                        while (r < height && !grid[r][col].isBlack) {
                            answer += grid[r][col].content;
                            r++;
                        }
                        let index = `${number}D`;
                        entries.get(index)!.entry = answer; // Fill the entry for across clue
                    }
                }
            }
        }
        
        let puzzle: Puzzle = {
            publication: this.id,
            title: title,
            authors: authorLine.split(',').map(s => s.trim()),
            copyright: "",
            date,
            sourceLink: url,
            width,
            height,
            grid,
            entries,
            lang: "en"
        };

        return puzzle;
      }
    }
