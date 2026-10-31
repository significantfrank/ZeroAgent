export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'max'] as const;

/** Canonical reasoning effort levels understood by the agent. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Credentials for a provider, loaded from `~/.zeroagent/auth.json`. */
export type ProviderAuth = {
    /** Provider base URL (the authoritative endpoint). */
    baseUrl: string;
    /** Auth type. Only `api_key` is supported. */
    type: 'api_key';
    /** API key for the provider. */
    key: string;
};

/** Maps canonical effort levels to provider-specific values (`null` = unsupported). */
export type ThinkingLevelMap = Partial<Record<EffortLevel, string | null>>;

/** A model definition, loaded from `~/.zeroagent/models-config.json`. */
export type ModelDefinition = {
    /** Model id — also the value sent to the API as `model`. */
    id: string;
    /** Provider name, matching a key in `auth.json`. */
    provider: string;
    /** Optional human-readable display name. */
    name?: string;
    /** Whether the model supports reasoning. Defaults to `false`. */
    reasoning?: boolean;
    /** Maps canonical effort levels to provider-specific values. */
    thinkingLevelMap?: ThinkingLevelMap;
    /** Maximum output tokens, forwarded as `max_output_tokens`. */
    maxTokens?: number;
};

/** Resolved provider endpoint + key, used to construct a client. */
export type ProviderCredentials = {
    baseUrl: string;
    key: string;
};
