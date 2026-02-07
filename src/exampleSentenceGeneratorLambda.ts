import { Context, APIGatewayProxyResult } from 'aws-lambda';
import { exampleSentenceGenerator } from './exampleSentenceGenerator';

/**
 * AWS Lambda handler for example sentence generation
 * Processes senses from the example_sentence_queue and generates example sentences using AI
 */
export const handler = async (event: any, context: Context): Promise<APIGatewayProxyResult> => {
  console.log('Example sentence generator Lambda started at:', new Date().toISOString());

  try {
    await exampleSentenceGenerator();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Example sentence generation completed successfully',
        timestamp: new Date().toISOString()
      }),
    };
  } catch (error) {
    console.error('Error in example sentence generator Lambda:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Example sentence generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }),
    };
  }
};