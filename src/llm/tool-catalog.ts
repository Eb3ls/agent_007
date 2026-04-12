// ============================================================
// src/llm/tool-catalog.ts — Static LLM tool/function definitions (T20)
// Describes the actions available to the LLM agent as
// OpenAI-compatible function-calling tool definitions.
// ============================================================

export interface ToolParameter {
  readonly type: string;
  readonly description: string;
  readonly enum?: readonly string[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, ToolParameter>;
    readonly required?: readonly string[];
  };
}

export const TOOL_CATALOG: readonly ToolDefinition[] = [
  {
    name: 'move',
    description:
      'Move the agent one step in the given cardinal direction. ' +
      'The server confirms movement; the position updates in the next sensing event.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: 'Cardinal direction to move.',
          enum: ['up', 'down', 'left', 'right'],
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'pickup',
    description:
      'Pick up all parcels located on the current tile. ' +
      'Returns the list of parcels picked up. No-op if no parcels are present.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'putdown',
    description:
      'Put down all carried parcels. Only scores if done on a delivery zone tile. ' +
      'Putting down elsewhere leaves parcels on the floor.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'send_message',
    description:
      'Send a text message to a known ally agent by their agent ID.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient ally agent ID.',
        },
        content: {
          type: 'string',
          description: 'Message payload (keep brief).',
        },
      },
      required: ['to', 'content'],
    },
  },
];

/** Serialised JSON string of the tool catalog — ready to embed in prompts. */
export const TOOL_CATALOG_JSON: string = JSON.stringify(TOOL_CATALOG, null, 2);
