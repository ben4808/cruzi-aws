import  { Pool } from 'pg';
import { PostgresParameter } from './PostgresParameter';
import settings from '../../settings.json';

let pool = new Pool({
    user: settings.db_user,
    host: settings.db_host,
    database: 'cruzi',
    password: settings.db_password,
    port: 5432,
});

export async function sqlQuery(isFunction: boolean, queryOrFunctionName: string, parameters?: PostgresParameter[]): Promise<any[]> {
    try {
        // Prepare the query text and parameter values
        let queryText: string;
        const paramValues: (string | Date | number | boolean | any[] | null)[] = 
            parameters ? parameters.map(param => {
                // If the parameter value is an array, stringify it for jsonb
                if (Array.isArray(param.value)) {
                    return JSON.stringify(param.value);
                }
                return param.value;
            }) : [];

        if (isFunction) {
            // For function calls, format as SELECT * FROM function_name($1, $2, ...)
            const placeholders = parameters ? parameters.map((_, index) => `$${index + 1}`).join(', ') : '';
            queryText = `SELECT * FROM ${queryOrFunctionName}(${placeholders})`;
        } else {
            // For regular queries, use the provided query text
            queryText = queryOrFunctionName;
        }

        // Execute the query with parameters
        const result = await pool.query(queryText, paramValues);

        // Return the rows as an array
        return result.rows;
    } catch (err) {
        console.error('SQL query error:', err);
        throw err; // Re-throw to allow the caller to handle the error
    }
}
