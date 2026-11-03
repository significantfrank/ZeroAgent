export interface MemoryProvider {
    retain(content: string): Promise<void>;
    recall(query: string): Promise<readonly string[]>;
}
