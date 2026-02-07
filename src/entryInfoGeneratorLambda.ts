import { Context, APIGatewayProxyResult } from 'aws-lambda';
import { entryInfoGenerator } from './entryInfoGenerator';

/**
 * AWS Lambda handler for entry info generation
 * Processes entries from the entry_info_queue and generates sense information using AI
 */
export const handler = async (event: any, context: Context): Promise<APIGatewayProxyResult> => {
  console.log('Entry info generator Lambda started at:', new Date().toISOString());

  try {
    await entryInfoGenerator();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Entry info generation completed successfully',
        timestamp: new Date().toISOString()
      }),
    };
  } catch (error) {
    console.error('Error in entry info generator Lambda:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Entry info generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }),
    };
  }
};