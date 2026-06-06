import { ScrapedPuzzle, PuzzleEntry, Square, PublicationId } from 'cruzi-models';
import { parse } from 'node-html-parser';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { decode } from 'html-entities';
import { newPuzzle } from "../lib/puzzle";


export class NYTSource implements PuzzleSource {
    public id = "NYT";
    public name = "New York Times";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
        let url = `https://www.xwordinfo.com/Crossword?date=${date.getMonth()+1}/${date.getDate()}/${date.getFullYear()}`;
        //url = `https://www.xwordinfo.com/Crossword?date=05/31/2026`;
        let weoriginUrl = 'https://everyorigin.jwvbremen.nl/get?url=' + encodeURIComponent(url);

        let parsedHtml;
        let success = false;
        while(!success) {
          try {
            let response = await fetch(url);
            let textResponse = await response.text();
            //let jsonResponse = await response.json();
            parsedHtml = parse(textResponse);
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
                square.content = col.querySelector(".letter")?.textContent || 
                    col.querySelector(".subst")?.textContent ||
                    col.querySelector(".subst2")?.textContent ||
                    "";

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
                clue: normalizeWindows1252ToIso8859_1(decode(clueMatches.groups ? clueMatches.groups["clue"] : "")),
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
                clue: normalizeWindows1252ToIso8859_1(decode(clueMatches.groups ? clueMatches.groups["clue"] : "")),
            } as PuzzleEntry);
        }

        let puzzle = newPuzzle(width, height);
        puzzle.publicationId = this.id as PublicationId;
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

function normalizeWindows1252ToIso8859_1(text: string): string {
    const map: Record<string, string> = {
      // Misdecoded C1 controls (Windows-1252 bytes read as ISO-8859-1)
      '\u0080': '',    // €
      '\u0082': "'",   // ‚
      '\u0083': 'f',   // ƒ
      '\u0084': '"',   // „
      '\u0085': '...', // …
      '\u0086': '',    // †
      '\u0087': '',    // ‡
      '\u0088': '^',   // ˆ
      '\u0089': '',    // ‰
      '\u008A': 'S',   // Š
      '\u008B': '<',   // ‹
      '\u008C': 'OE',  // Œ
      '\u008E': 'Z',   // Ž
      '\u0091': "'",   // ‘
      '\u0092': "'",   // ’
      '\u0093': '"',   // “
      '\u0094': '"',   // ”
      '\u0095': '',    // •
      '\u0096': '-',   // –
      '\u0097': '-',   // —
      '\u0098': '~',   // ˜
      '\u0099': '',    // ™
      '\u009A': 's',   // š
      '\u009B': '>',   // ›
      '\u009C': 'oe',  // œ
      '\u009E': 'z',   // ž
      '\u009F': 'Y',   // Ÿ
      // Actual Unicode characters from Windows-1252 not in ISO-8859-1
      '\u20AC': '',    // €
      '\u201A': "'",   // ‚
      '\u0192': 'f',   // ƒ
      '\u201E': '"',   // „
      '\u2026': '...', // …
      '\u2020': '',    // †
      '\u2021': '',    // ‡
      '\u02C6': '^',   // ˆ
      '\u2030': '',    // ‰
      '\u0160': 'S',   // Š
      '\u2039': '<',   // ‹
      '\u0152': 'OE',  // Œ
      '\u017D': 'Z',   // Ž
      '\u2018': "'",   // ‘
      '\u2019': "'",   // ’
      '\u201C': '"',   // “
      '\u201D': '"',   // ”
      '\u2022': '',    // •
      '\u2013': '-',   // –
      '\u2014': '-',   // — (em dash)
      '\u02DC': '~',   // ˜
      '\u2122': '',    // ™
      '\u0161': 's',   // š
      '\u203A': '>',   // ›
      '\u0153': 'oe',  // œ
      '\u017E': 'z',   // ž
      '\u0178': 'Y',   // Ÿ
    };
    return text.replace(/[\u0080-\u009F\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u201A\u201E\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u02DC\u2122\u0161\u203A\u0153\u017E\u0178\u0192]/g, (c) => map[c] ?? '');
  }
