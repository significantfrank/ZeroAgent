import type { Agent } from '../agent/agent-loop.ts';
import type { SessionManager } from '../session/manager.ts';
import type { ModelRegistry } from './registry.ts';

/** Render one line per model, with `*` marking the active model. */
export function formatModels(registry: ModelRegistry, activeModel: string): string[] {
    const models = registry.list();
    if (models.length === 0) return ['No models configured.'];
    return models.map((model) => {
        const active = model.id === activeModel ? '*' : ' ';
        const reasoning = model.reasoning === true ? 'on' : 'off';
        const efforts = registry.availableEfforts(model.id);
        const levels = efforts === undefined || efforts.length === 0 ? '-' : efforts.join(',');
        return `${active} ${model.id}  provider: ${model.provider}  reasoning: ${reasoning}  levels: ${levels}`;
    });
}

/**
 * Switch the agent's active model, persisting it to the active session.
 * Returns `false` when the model id is not registered.
 */
export function switchModel(agent: Agent, registry: ModelRegistry, manager: SessionManager | undefined, id: string): boolean {
    if (registry.get(id) === undefined) return false;
    agent.setModel(id);
    const sessionId = agent.sessionId;
    if (manager !== undefined && sessionId !== undefined) {
        manager.setSessionModel(sessionId, id);
    }
    return true;
}

/** Restore a session's stored model onto the agent, ignoring an empty model. */
export function restoreSessionModel(agent: Agent, model: string): void {
    if (model !== '') agent.setModel(model);
}
