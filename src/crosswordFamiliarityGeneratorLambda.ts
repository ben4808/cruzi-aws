import { Context, APIGatewayProxyResult } from 'aws-lambda';
import { crosswordFamiliarityGenerator } from './crosswordFamiliarityGenerator';

/**
 * AWS Lambda handler for crossword familiarity generation
 * Processes entries from the crossword_familiarity_queue and generates familiarity information using AI
 */
export const handler = async (event: any, context: Context): Promise<APIGatewayProxyResult> => {
  console.log('Crossword familiarity generator Lambda started at:', new Date().toISOString());

  try {
    await crosswordFamiliarityGenerator();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Crossword familiarity generation completed successfully',
        timestamp: new Date().toISOString()
      }),
    };
  } catch (error) {
    console.error('Error in crossword familiarity generator Lambda:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Crossword familiarity generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }),
    };
  }
};
