import type { FunctionCallItem, FunctionTool } from './types.ts';

export type ToolResult = {
    callId: string;
    name: string;
    output: string;
    error?: string;
};

export const weatherTool: FunctionTool = {
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
        additionalProperties: false,
    },
    strict: true,
};

function getWeather(city: string): string {
    const weather: Record<string, { temperature_c: number; condition: string }> = {
        'new york': { temperature_c: 22, condition: 'sunny' },
        tokyo: { temperature_c: 18, condition: 'cloudy' },
        london: { temperature_c: 14, condition: 'rainy' },
    };
    const result = weather[city.toLowerCase()] ?? { temperature_c: 20, condition: 'clear' };
    return JSON.stringify({ city, ...result });
}

export function executeTool(call: FunctionCallItem): ToolResult {
    try {
        if (call.name !== weatherTool.name) {
            return { callId: call.call_id, name: call.name, output: `Unknown tool: ${call.name}`, error: 'unknown_tool' };
        }
        const args: unknown = JSON.parse(call.arguments);
        if (typeof args !== 'object' || args === null || typeof (args as { city?: unknown }).city !== 'string') {
            return { callId: call.call_id, name: call.name, output: 'Tool arguments must contain a string city', error: 'invalid_arguments' };
        }
        return { callId: call.call_id, name: call.name, output: getWeather((args as { city: string }).city) };
    } catch (error) {
        return {
            callId: call.call_id,
            name: call.name,
            output: error instanceof Error ? error.message : String(error),
            error: 'tool_error',
        };
    }
}