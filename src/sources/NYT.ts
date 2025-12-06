import { PuzzleSource } from "../models/PuzzleSource";
import { parse } from 'node-html-parser';
import { Square } from "../models/Square";
import { Puzzle } from "../models/Puzzle";
import { PuzzleEntry } from "../models/PuzzleEntry";
import { decode } from 'html-entities';
import { newPuzzle } from "../lib/puzzle";

export class NYTSource implements PuzzleSource {
    public id = "NYT";
    public name = "New York Times";

    public async getPuzzle(date: Date): Promise<Puzzle> {
        let url = `https://www.xwordinfo.com/Crossword?date=${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`;
        //url = `https://www.xwordinfo.com/Crossword?date=12/17/2020`;
        let weoriginUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);

        let parsedHtml;
        let success = false;
        while(!success) {
          try {
            let response = await fetch(weoriginUrl); 
            let jsonResponse = await response.json();
            parsedHtml = parse(jsonResponse.contents);
            success = true;
          } catch (error) {
              console.log(`Failed to fetch or parse NYT puzzle: ${error}`);
          }
        }

        if (!parsedHtml) {
            throw new Error("Failed to parse NYT puzzle HTML.");
        }

        let title = parsedHtml.querySelector("#PuzTitle")!.textContent;
        let authors = parsedHtml.querySelectorAll(".bbName > a").map(x => x.textContent);
        if (authors.length === 0) authors = parsedHtml.querySelectorAll(".bbName2 > a").map(x => x.textContent);
        let copyright = `© ${date.getFullYear()}, The New York Times`;
        let notes = parsedHtml.querySelector(".notepad")?.textContent.replace("<b>Notepad:</b>", "") || undefined;
        let puzDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        let source = this.id;

        let grid = [] as Square[][];
        let puzTable = parsedHtml.querySelector("#PuzTable")!;
        let rows = puzTable.querySelectorAll("tr");
        let height = rows.length;
        let width = 0;
        rows.forEach((row, ri) => {
            let gridRow = [] as Square[];

            let cols = row.querySelectorAll("td");
            if (width === 0) width = cols.length;
            cols.forEach((col, ci) => {
                let square = {
                    row: ri,
                    col: ci,
                    directions: [],
                    isBlack: false,
                    content: "",
                    isCircled: false,
                } as Square;

                if (col.getAttribute("class")?.includes("black")) {
                    square.isBlack = true;
                    gridRow.push(square);
                    return;
                }

                square.number = +col.querySelector(".num")!.textContent || undefined;
                square.content = col.querySelector(".letter")!.textContent;
                if (!square.content) square.content = col.querySelector(".subst")!.textContent;
                if (!square.content) square.content = col.querySelector(".subst2")!.textContent;

                if (col.getAttribute("class")?.includes("shade") || col.getAttribute("class")?.includes("bigcircle")) {
                    square.isCircled = true;
                }

                gridRow.push(square);
            });

            grid.push(gridRow);
        });

        let puzEntries = new Map<string, PuzzleEntry>();

        let acrossClues = parsedHtml.querySelector("#ACluesPan .numclue")!.childNodes;
        for (let i = 0; i < acrossClues.length; i += 2) {
            let number = +acrossClues[i].innerText;
            let clueText = acrossClues[i+1].innerText;
            let clueMatches = clueText.match(/(?<clue>.*) : (?<entry>[A-Z0-9]+)/)!;
            
            let key = number.toString() + "A";
            puzEntries.set(key, {
                index: key,
                entry: clueMatches.groups ? clueMatches.groups["entry"]: "",
                clue: decode(clueMatches.groups ? clueMatches.groups["clue"] : ""),
            } as PuzzleEntry);
        }

        let downClues = parsedHtml.querySelector("#DCluesPan .numclue")!.childNodes;
        for (let i = 0; i < downClues.length; i += 2) {
            let number = +downClues[i].innerText;
            let clueText = downClues[i+1].innerText;
            let clueMatches = clueText.match(/(?<clue>.*) : (?<entry>[A-Z0-9]+)/)!;
            
            let key = number.toString() + "D";
            puzEntries.set(key, {
                index: key,
                entry: clueMatches.groups ? clueMatches.groups["entry"]: "",
                clue: decode(clueMatches.groups ? clueMatches.groups["clue"] : ""),
            } as PuzzleEntry);
        }

        let puzzle = newPuzzle(width, height);
        puzzle.publication = this.id;
        puzzle.title = title;
        puzzle.authors = authors;
        puzzle.copyright = copyright;
        puzzle.notes = notes;
        puzzle.date = puzDate;
        puzzle.sourceLink = source;
        puzzle.grid = grid;
        puzzle.entries = puzEntries;
        puzzle.lang = "en"; // NYT puzzles are always in English
        puzzle.sourceLink = url; // Link to the source of the puzzle

        return puzzle;
    }
}
