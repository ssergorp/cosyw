// services/ReplicateService.js

import Replicate from 'replicate';
import logger from './logger.mjs'; // Assuming you have a logger set up

/**
 * Utility function to capitalize the first letter of a string.
 * @param {string} str - The string to capitalize.
 * @returns {string} - Capitalized string.
 */
function capitalize(str) {
  if (typeof str !== 'string') return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export class ReplicateService {
  /**
   * Initializes the ReplicateService with the provided API token.
   * @param {string} apiToken - Your Replicate API token.
   */
  constructor(apiToken = process.env.REPLICATE_API_TOKEN) {
    if (!apiToken) {
      throw new Error('Replicate API token is required.');
    }
    this.replicate = new Replicate({
      auth: apiToken,
    });
    this.defaultModel = 'meta/meta-llama-3.1-405b-instruct'; // Replace with your actual model
  }

  /**
   * Generates a text completion based on the provided prompt.
   * @param {string} prompt - The input prompt for text generation.
   * @param {object} options - Additional options for the model (e.g., temperature, max_length).
   * @returns {Promise<string|null>} - The generated completion or null if failed.
   */
  async generateCompletion(prompt, options = {}) {
    try {
      if (!prompt || typeof prompt !== 'string') {
        logger.error('Invalid prompt provided to generateCompletion.');
        return null;
      }

      logger.info('Generating completion with Replicate.');

      // Define the model identifier; replace with your chosen text generation model
      const modelIdentifier = this.defaultModel;

      // Structure the input based on the model's requirements
      const input = {
        prompt,
        // Include other options if supported by the model
        // For example:
        // temperature: options.temperature || 0.7,
        // max_length: options.max_length || 100,
        ...options.input, // Spread any additional input options
      };

      // Run the model
      const output = (await this.replicate.run(modelIdentifier, { input })).join('');

      if (!output) {
        logger.error('Invalid response from Replicate during completion generation.');
        return null;
      }

      // Assuming the model returns a string. Adjust if your model returns a different format.
      const completion = typeof output === 'string' ? output.trim() : JSON.stringify(output).trim();

      logger.info('Completion generated successfully.');
      return completion;
    } catch (error) {
      // Enhanced error logging
      if (error.response) {
        // The request was made, and the server responded with a status code outside 2xx
        logger.error(`Replicate API Error: ${error.response.status} - ${error.response.statusText}`);
      } else if (error.request) {
        // The request was made, but no response was received
        logger.error('No response received from Replicate:', error.request);
      } else {
        // Something else happened
        logger.error('Error while generating completion from Replicate:', error.message);
      }
      return null;
    }
  }

  /**
   * Simulates a chat by maintaining conversation history.
   *
   * @param {Array} conversationHistory - Array of message objects with role and content.
   * @param {object} options - Additional options for the Replicate run.
   * @returns {Promise<string|null>} - The assistant's response or null if failed.
   */
  async chat(conversationHistory, options = {}) {
    try {
      // Format the conversation history into the required prompt template
      const prompt = this.formatPrompt(conversationHistory);

      logger.info('Sending prompt to Replicate:', prompt);

      // Define input based on your model's requirements
      const input = { prompt, ...options.input };

      // Run the model
      const output = await this.replicate.run(this.defaultModel, { input });

      if (!output) {
        logger.error('Invalid response from Replicate during chat.');
        return null;
      }

      logger.info('Received response from Replicate:', output);

      // Assuming the model returns a string. Adjust if your model returns a different format.
      const assistantResponse = typeof output === 'string' ? output.trim() : JSON.stringify(output).trim();

      return assistantResponse;
    } catch (error) {
      // Enhanced error logging
      if (error.response) {
        logger.error(`Replicate API Error: ${error.response.status} - ${error.response.statusText}`);
      } else if (error.request) {
        logger.error('No response received from Replicate:', error.request);
      } else {
        logger.error('Error while chatting with Replicate:', error.message);
      }
      return null;
    }
  }

  /**
   * Converts conversationHistory to the required prompt format with special tokens.
   * @param {Array} conversationHistory - Array of message objects with role and content.
   * @returns {string} - Formatted prompt string.
   */
  formatPrompt(conversationHistory) {
    const beginToken = '<|begin_of_text|>';
    const endOfTextToken = '<|eot_id|>';

    const formattedMessages = conversationHistory.map(msg => {
      const roleTokenStart = `<|start_header_id|>${msg.role}<|end_header_id|>`;
      const content = msg.content;
      return `${roleTokenStart}\n\n${content}${endOfTextToken}`;
    }).join('\n');

    return `${beginToken}\n${formattedMessages}`;
  }
}
