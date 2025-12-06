import { Puzzle } from "../models/Puzzle";
import { PuzzleEntry } from "../models/PuzzleEntry";
import { Square } from "../models/Square";

export function newPuzzle(width: number, height: number): Puzzle {
    return {
        title: "",
        date: new Date(),
        source: "",
        authors: [],
        copyright: "",
        width: width,
        height: height,
    
        grid: newGrid(width, height),
        entries: new Map<string, PuzzleEntry>(),
    } as Puzzle;
}

export function newGrid(width: number, height: number): Square[][] {
    let ret = [] as Square[][];
    for (let row = 0; row < height; row++) {
        ret.push([])
        for (let col = 0; col < width; col++) {
            ret[row].push(newSquare(row, col))
        }
    }
    return ret
}

function newSquare(row: number, col: number): Square {
    return {
        row: row,
        col: col,
        isBlack: false,
        content: "",
        isCircled: false,
    } as Square;
}

export function numberizeGrid(grid: Square[][]) {
    let currentNumber = 1;

    let height = grid.length;
    let width = grid[0].length;
    for(var row = 0; row < height; row++) {
        for (var col = 0; col < width; col++) {
            var sq = grid[row][col];  
            sq.number = undefined;
            sq.directions = [];

            if (sq.isBlack) continue;

            let isAboveBlocked = (row === 0 || grid[row-1][col].isBlack);
            let isBelowBlocked = (row === height-1 || grid[row+1][col].isBlack);
            let isLeftBlocked = (col === 0 || grid[row][col-1].isBlack);
            let isRightBlocked = (col === width-1 || grid[row][col+1].isBlack);

            let isAcrossStart = isLeftBlocked && !isRightBlocked;
            let isDownStart = isAboveBlocked && !isBelowBlocked;
            //let isIsolatedSquare = isLeftBlocked && isRightBlocked && isAboveBlocked && isBelowBlocked;

            if (isAcrossStart || isDownStart) sq.number = currentNumber++;
            if (isAcrossStart) sq.directions.push("A");
            if (isDownStart) sq.directions.push("D");
        }
    }
}
