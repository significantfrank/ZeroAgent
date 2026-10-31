import type { AgentEvent } from './types.ts';
import type { SessionManager } from '../session/manager.ts';
import type { ExtensionRunner } from '../extension/runner.ts';
import { logger } from '../logger.ts';

/**
 * Processes AgentEvents from `Agent.stream()` and persists user/assistant
 * messages to the session store via SessionManager.
 *
 * The bridge is constructed per `stream()` call with the user input and
 * the active session. Call `handleAgentEvent(event)` for every event
 * yielded by the stream. Each event is also exposed to extensions as the
 * richer `ExtensionEvent`; the optional `ExtensionRunner` is shared with
 * the `Agent` so `before_agent_start` mutations apply to the same run.
 */
export class AgentBridge {
    readonly #sessionManager: SessionManager;
    readonly #sessionId: string;
    readonly #input: string;
    readonly #extensions: ExtensionRunner | undefined;
    #userPersisted = false;
    #turnHadError = false;
    #turnHadToolCalls = false;

    constructor(
        sessionManager: SessionManager,
        sessionId: string,
        input: string,
        extensions?: ExtensionRunner,
    ) {
        this.#sessionManager = sessionManager;
        this.#sessionId = sessionId;
        this.#input = input;
        this.#extensions = extensions;
    }

    async handleAgentEvent(event: AgentEvent): Promise<void> {
        logger.debug('log/agent-event.log', `[${event.type}] ${JSON.stringify(event)}`);
        // Convert the raw AgentEvent into the richer ExtensionEvent and notify
        // extensions before applying the bridge's own persistence side effects.
        await this.#extensions?.emit(event, { input: this.#input });
        switch (event.type) {
            case 'agent_start':
                if (!this.#userPersisted) {
                    this.#sessionManager.appendMessage(this.#sessionId, 'user', this.#input);
                    this.#userPersisted = true;
                }
                break;
            case 'turn_start':
                this.#turnHadError = false;
                this.#turnHadToolCalls = false;
                break;
            case 'turn_end':
                this.#turnHadToolCalls = event.message.role === 'assistant' &&
                    (event.message.toolCalls?.length ?? 0) > 0;
                break;
            case 'error':
                this.#turnHadError = true;
                break;
            case 'agent_end':
                if (!this.#turnHadError && !this.#turnHadToolCalls) {
                    this.#sessionManager.appendMessage(this.#sessionId, 'assistant', event.message.content);
                }
                break;
        }
    }
}
