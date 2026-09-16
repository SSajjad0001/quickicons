/**
 * SVG structural fingerprinting + similarity scoring for reverse icon search.
 */

export type SvgFingerprint = {
  compact: string;
  tags: string[];
  tagBag: Record<string, number>;
  pathDigests: string[];
  pathTokens: string[];
  commands: string;
};

const TAG_RE = /<\s*\/?\s*([a-zA-Z][\w:-]*)/g;
const PATH_D_RE = /\bd\s*=\s*["']([^"']+)["']/gi;
const NUM_RE = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

export function buildSvgFingerprint(raw: string): SvgFingerprint | undefined {
  const cleaned = cleanSvgSource(raw);
  if (!cleaned || !/<svg[\s>]|<\s*path[\s>]|<\s*circle[\s>]|<\s*rect[\s>]|<\s*g[\s>]/i.test(cleaned)) {
    // Still allow path-only fragments
    if (!/d\s*=/i.test(cleaned) && !/<[a-z]/i.test(cleaned)) {
      return undefined;
    }
  }

  const compact = cleaned.replace(/\s+/g, " ").trim().toLowerCase();
  const tags: string[] = [];
  const tagBag: Record<string, number> = {};
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase().replace(/^svg:/, "");
    if (tag === "svg" || tag === "?xml" || tag === "!--") {
      continue;
    }
    tags.push(tag);
    tagBag[tag] = (tagBag[tag] ?? 0) + 1;
  }

  const pathDigests: string[] = [];
  const pathTokens: string[] = [];
  const commandParts: string[] = [];
  PATH_D_RE.lastIndex = 0;
  while ((m = PATH_D_RE.exec(cleaned)) !== null) {
    const normalized = normalizePathD(m[1]);
    if (!normalized) {
      continue;
    }
    pathDigests.push(simpleHash(normalized));
    const tokens = tokenizePathD(normalized);
    pathTokens.push(...tokens);
    commandParts.push(normalized.replace(/[^a-z]/gi, ""));
  }

  return {
    compact,
    tags,
    tagBag,
    pathDigests: unique(pathDigests),
    pathTokens: unique(pathTokens).slice(0, 400),
    commands: commandParts.join("|").toLowerCase(),
  };
}

export function scoreSvgSimilarity(query: SvgFingerprint, candidate: SvgFingerprint): number {
  if (!query.compact || !candidate.compact) {
    return 0;
  }

  // Exact / near-exact markup
  if (query.compact === candidate.compact) {
    return 1;
  }
  if (
    query.compact.length > 24 &&
    (candidate.compact.includes(query.compact) || query.compact.includes(candidate.compact))
  ) {
    return 0.97;
  }

  let score = 0;
  let weight = 0;

  // Path digest overlap (strong signal)
  const digestJ = jaccard(query.pathDigests, candidate.pathDigests);
  if (query.pathDigests.length || candidate.pathDigests.length) {
    score += digestJ * 0.45;
    weight += 0.45;
  }

  // Path token overlap (shape similarity)
  const tokenJ = jaccard(query.pathTokens, candidate.pathTokens);
  if (query.pathTokens.length || candidate.pathTokens.length) {
    score += tokenJ * 0.3;
    weight += 0.3;
  }

  // Command signature similarity
  const cmdSim = stringSimilarity(query.commands, candidate.commands);
  if (query.commands || candidate.commands) {
    score += cmdSim * 0.1;
    weight += 0.1;
  }

  // Tag multiset similarity
  const tagSim = bagSimilarity(query.tagBag, candidate.tagBag);
  score += tagSim * 0.15;
  weight += 0.15;

  if (weight <= 0) {
    return 0;
  }

  const normalized = score / weight;

  // Boost if primary path digest matches exactly
  if (digestJ === 1 && query.pathDigests.length > 0) {
    return Math.min(1, normalized + 0.2);
  }

  return Math.max(0, Math.min(1, normalized));
}

function cleanSvgSource(raw: string): string {
  return raw
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trim();
}

function normalizePathD(d: string): string {
  return d
    .trim()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(NUM_RE, (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) {
        return n;
      }
      // Round to reduce float noise across exporters
      return String(Math.round(v * 10) / 10);
    })
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizePathD(normalized: string): string[] {
  const tokens: string[] = [];
  const re = /([a-z])|(-?\d*\.?\d+)/gi;
  let m: RegExpExecArray | null;
  let cmd = "";
  while ((m = re.exec(normalized)) !== null) {
    if (m[1]) {
      cmd = m[1].toLowerCase();
      tokens.push(`c:${cmd}`);
    } else if (m[2] != null) {
      const rounded = String(Math.round(Number(m[2])));
      tokens.push(`n:${cmd}:${rounded}`);
    }
  }
  return tokens;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) {
    return 0;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) {
      inter += 1;
    }
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bagSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (!keys.size) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (!magA || !magB) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function stringSimilarity(a: string, b: string): number {
  if (!a && !b) {
    return 0;
  }
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) {
    return 0;
  }
  // cheap bigram Dice coefficient
  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, c] of A) {
    overlap += Math.min(c, B.get(g) ?? 0);
  }
  return (2 * overlap) / (a.length + b.length - 2 || 1);
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}
