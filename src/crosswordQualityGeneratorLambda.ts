import { Context, APIGatewayProxyResult } from 'aws-lambda';
import { crosswordQualityGenerator } from './crosswordQualityGenerator';

/**
 * AWS Lambda handler for crossword quality generation
 * Processes entries from the crossword_quality_queue and generates quality information using AI
 */
export const handler = async (event: any, context: Context): Promise<APIGatewayProxyResult> => {
  console.log('Crossword quality generator Lambda started at:', new Date().toISOString());

  try {
    await crosswordQualityGenerator();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Crossword quality generation completed successfully',
        timestamp: new Date().toISOString()
      }),
    };
  } catch (error) {
    console.error('Error in crossword quality generator Lambda:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Crossword quality generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }),
    };
  }
};
