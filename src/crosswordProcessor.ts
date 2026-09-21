/*
This is a multistep process.
Only one puzzle_id should be processed at a time, but the clues can be processed in parallel.
All items in a given step should be completed before moving on to the next step.
Each queue will have a puzzle_id indicator so we know which items to pull on each step.

Parallel processing should be handled as familiarGenerator.ts does.

STEP 1:
- Pull a puzzle_id from crossword_processing_queue.
- Fetch all the clues and entries for the given puzzle_id. Include all existing senses for the entries.
  - Look for senses both from the entry itself and from its base form if it exists. 
    Look for the entry in the inflected_entry table to find the base form.
- Take all entries from the puzzle that have no display_text, and run them through the process in entryParser.ts. 
    Refactor out the necessary code from entryParser.ts to avoid code duplication.
- If there are entries that do not have any senses, add those entries immediately to the sense_generator_queue 
    with the clue as a hint.
- For entries that have senses, generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
- Update the clue records with the matched sense ids.
- If there are entries that could not be matched to an existing sense, add them to the sense_generator_queue with 
    the hint as the sense summary returned by the AI for that entry.
    - You know that an existing sense was not matched because the prompt returned an invented sense summary.
    - If the prompt returns Unclear, assign that clue to a random sense.
- All senses that were successfully matched with a clue should be added to the sense_scoring_queue, provided they
    have a reviewed_status that is not "234". Also they should be added to the sense_reference_queue unless they
    already have records in the sense_reference table.

STEP 2:
- Fetch items from the sense_generator_queue for the puzzle_idand build AI prompts with senses_prompt.txt. (One item per prompt.)
- As well as the hint, send every different display_text of the entry to the prompt. If there are already senses for the
   entry, this would be all the display_text values of the existing senses. If there are no existing senses, send the
   display_text of the entry record and all corresponding entry_secondary_class records.
- Insert the sense information into the database and enqueue again the puzzle_id in the crossword_processing_queue.
- If a sense comes back with summary of "Literal", insert "Literal" into the summary field and leave the definition field blank.
- Keep track of the items that were sent through the senses prompt for the next step.

STEP 3:
- For entries processed in step 2, generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
- If there are entries that could not be matched to an existing sense, assign them to a random sense.
- Update the clue records with the matched sense ids.

STEP 4:
- Fetch items from the sense_scoring_queue for the puzzle_id (number based on the parallel processing parameters).
- Run the items through a pipeline of sense_unity_prompt.txt, sense_familiarity_prompt.txt, and sense_quality_prompt.txt. 
   Take inspiration from unityGenerator.ts, familiarityGenerator.ts, and qualityGenerator.ts to implement the pipeline,
   refactoring out common code where possible to avoid code duplication.
- After the unity prompt, update the reviewed_status of the sense to "2". After the familiarity prompt, update the 
   reviewed_status to "23". After the quality prompt, update the reviewed_status to "234".
- Batches of 50.

STEP 5:
- Fetch items from the sense_reference_queue for the puzzle_id (number based on the parallel processing parameters).
- Generate an AI request to sense_reference_prompt.txt with the entries. Send 10 per prompt.
- Update the sense_reference table with the new references.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/
