/*
Keep looping through the following steps:
1. Select a random 10 entries from the entry table using the get_entries_for_entry_improver function.
2. For each entry, generate a prompt using the entry_improver_prompt.txt file.
3. Send the prompt to Gemini (using GeminiWebAiProvider logged in, extended model) and get the response.
4. Upsert the entry, overwriting a number of fields:
    - entry_type
    - display_text
    - base_form
    - unity_bucket
    - unity_score (Concept = 5, Collocation = 4, Formula = 3, Non-unit = 2, Nonsense = 1)
    - familiarity_bucket
    - familiarity_score (Beginner Core = 50, Fundamental = 45, Active = 40, Easy Collocation = 35, 
        Well-Known = 30, Less Known = 25, Recognized = 20, Niche = 15, Unknown = 10, Nonsense = 0)
    - quality_bucket
    - quality_score (Warm = 40, Fun = 35, Interesting = 35, Normal = 30, Non-Dominant = 25, 
        Awkward = 20, Barely Coherent = 15, Nonsense = 0)
    - is_vulgar
    - reviewed_status = 'R'

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/
