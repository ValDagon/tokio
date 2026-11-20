export function normalizeAntiSplit(text: string): string;
export function scanContent(
  content: string,
  rel: string,
  options?: { privatePatterns?: string[] },
): string[];
export function collectTargetFiles(rootDir?: string): Set<string>;
export function loadPrivatePatterns(rootDir?: string): string[];
