export type Frontmatter = {
    name?: string;
    description?: string;
};

/**
 * Split Markdown content into flat name/description frontmatter and body.
 */
export function splitFrontmatter(content: string, source: string): { frontmatter: Frontmatter; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (match === null) {
        throw new Error(`File "${source}" is missing YAML frontmatter. Expected "---" delimited block at the start of the file.`);
    }

    const frontmatter: Frontmatter = {};
    for (const line of match[1]!.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex === -1) {
            throw new Error(`File "${source}" has malformed frontmatter line: "${trimmed}"`);
        }
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();
        if (key === 'name' || key === 'description') {
            frontmatter[key] = value;
        }
    }

    return { frontmatter, body: match[2]! };
}