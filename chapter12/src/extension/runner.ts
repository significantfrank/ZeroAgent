import { pathToFileURL } from 'node:url';
import type { AgentEvent } from '../agent/types.ts';
import { composeSystemPrompt, type SystemPromptOptions } from '../agent/system-prompt.ts';
import type {
    Extension,
    ExtensionAPI,
    ExtensionContext,
    ExtensionEvent,
    ExtensionEventType,
    ExtensionHandler,
    ExtensionResult,
    InjectableMessage,
    RegisteredCommand,
    RegisteredTool,
} from './types.ts';

/**
 * Drives extension lifecycle hooks through an agent run.
 *
 * The runner holds event handlers plus the tools and commands registered by
 * loaded extensions. Generic lifecycle events are emitted with `emit()`, while
 * the special `before_agent_start` hook — which can reshape the system prompt —
 * is emitted with `emitBeforeAgentStart()`.
 *
 * Extensions are loaded with `loadExtensionFile()` and tracked so they can be
 * unloaded and reloaded (`unloadExtension` / `unloadAll`).
 */
export class ExtensionRunner {
    readonly #handlers = new Map<ExtensionEventType, Set<ExtensionHandler>>();
    readonly #extensions = new Map<string, Extension>();
    readonly #commands = new Map<string, RegisteredCommand>();
    readonly #tools = new Map<string, RegisteredTool>();
    #generation = 0;

    /** Register a handler for one event type. Returns `this` for chaining. */
    on<K extends ExtensionEventType>(
        type: K,
        handler: ExtensionHandler<Extract<ExtensionEvent, { type: K }>>,
    ): this {
        let handlers = this.#handlers.get(type);
        if (handlers === undefined) {
            handlers = new Set();
            this.#handlers.set(type, handlers);
        }
        handlers.add(handler as ExtensionHandler);
        return this;
    }

    /** Remove a previously registered handler. Returns whether it was present. */
    off<K extends ExtensionEventType>(
        type: K,
        handler: ExtensionHandler<Extract<ExtensionEvent, { type: K }>>,
    ): boolean {
        const handlers = this.#handlers.get(type);
        if (handlers === undefined) return false;
        const removed = handlers.delete(handler as ExtensionHandler);
        if (handlers.size === 0) this.#handlers.delete(type);
        return removed;
    }

    /** Remove every handler, extension, command, and tool. */
    clear(): void {
        this.#handlers.clear();
        this.#extensions.clear();
        this.#commands.clear();
        this.#tools.clear();
    }

    /** The identifiers of the loaded extensions. */
    names(): string[] {
        return [...this.#extensions.keys()];
    }

    /** Look up a command registered by an extension. */
    getCommand(name: string): RegisteredCommand | undefined {
        return this.#commands.get(name);
    }

    /** All commands registered by extensions. */
    commands(): RegisteredCommand[] {
        return [...this.#commands.values()];
    }

    /** All tools registered by extensions. */
    registeredTools(): RegisteredTool[] {
        return [...this.#tools.values()];
    }

    /**
     * Import an extension module and run its default export with a fresh
     * `ExtensionAPI`. Registrations made through the API are tracked on the
     * returned `Extension` and dispatched like any direct registration.
     *
     * A cache-busting query param forces a fresh module evaluation on reload.
     * On failure, everything already registered is rolled back.
     */
    async loadExtensionFile(path: string, resolvedPath: string): Promise<Extension> {
        this.unloadExtension(path);

        const extension: Extension = { path, resolvedPath, handlers: new Map() };
        this.#extensions.set(path, extension);

        const api: ExtensionAPI = {
            on: (type, handler) => {
                const list = extension.handlers.get(type) ?? [];
                list.push(handler as ExtensionHandler);
                extension.handlers.set(type, list);
                this.on(type, handler);
            },
            registerCommand: (name, command) => {
                const registered: RegisteredCommand = { name, ...command };
                extension.commands ??= new Map();
                extension.commands.set(name, registered);
                this.#commands.set(name, registered);
            },
            registerTool: (definition, handler) => {
                const registered: RegisteredTool = { name: definition.name, definition, handler };
                extension.tools ??= new Map();
                extension.tools.set(registered.name, registered);
                this.#tools.set(registered.name, registered);
            },
        };

        try {
            const url = `${pathToFileURL(resolvedPath).href}?t=${this.#generation++}`;
            const module = await import(url);
            const factory = (module as { default?: unknown }).default;
            if (typeof factory !== 'function') {
                throw new Error('default export must be a function');
            }
            await (factory as (api: ExtensionAPI) => void | Promise<void>)(api);
            return extension;
        } catch (error) {
            this.unloadExtension(path);
            throw error;
        }
    }

    /** Unload one extension, deregistering everything it added. */
    unloadExtension(path: string): boolean {
        const extension = this.#extensions.get(path);
        if (extension === undefined) return false;

        for (const [type, handlers] of extension.handlers) {
            const registered = this.#handlers.get(type);
            if (registered === undefined) continue;
            for (const handler of handlers) registered.delete(handler);
            if (registered.size === 0) this.#handlers.delete(type);
        }
        if (extension.commands !== undefined) {
            for (const [name, command] of extension.commands) {
                if (this.#commands.get(name) === command) this.#commands.delete(name);
            }
        }
        if (extension.tools !== undefined) {
            for (const [name, tool] of extension.tools) {
                if (this.#tools.get(name) === tool) this.#tools.delete(name);
            }
        }
        this.#extensions.delete(path);
        return true;
    }

    /** Unload every tracked extension. Direct `on()` registrations are kept. */
    unloadAll(): void {
        for (const path of [...this.#extensions.keys()]) {
            this.unloadExtension(path);
        }
    }

    /**
     * Emit a generic lifecycle event to every handler for its type. Handlers
     * run in registration order; any returned mutations are ignored.
     */
    emit(event: AgentEvent, context: ExtensionContext): Promise<void> {
        return this.#dispatch(event, context).then(() => undefined);
    }

    /**
     * Emit the special `before_agent_start` hook. Handlers may mutate
     * `systemPromptOptions` in place and return `messages` to inject.
     */
    emitBeforeAgentStart(input: string, systemPromptOptions: SystemPromptOptions): Promise<ExtensionResult> {
        return this.#dispatch(
            {
                type: 'before_agent_start',
                input,
                systemPrompt: composeSystemPrompt(systemPromptOptions),
                systemPromptOptions,
            },
            { input },
        );
    }

    async #dispatch(event: ExtensionEvent, context: ExtensionContext): Promise<ExtensionResult> {
        const handlers = this.#handlers.get(event.type);
        if (handlers === undefined) return {};

        const messages: InjectableMessage[] = [];
        for (const handler of handlers) {
            const result = await handler(event, context);
            if (result !== undefined && result.messages !== undefined) {
                messages.push(...result.messages);
            }
        }
        return messages.length > 0 ? { messages } : {};
    }
}
