/**
 * Starter vocabulary lists for voice dictation. Picking one fills the
 * Vocabulary field; editing the text makes it the user's Custom list.
 * Words are sent with each recorded clip so the transcriber spells them right.
 */
export type VocabularyPreset = { id: string; label: string; words: string };

export const VOCABULARY_PRESETS: readonly VocabularyPreset[] = [
  {
    id: "algorithms",
    label: "Algorithms",
    words: "memoization, dynamic programming, BFS, DFS, Dijkstra, topological sort, binary search, two pointers, sliding window, union-find, backtracking, greedy",
  },
  {
    id: "data-structures",
    label: "Data structures",
    words: "linked list, hash map, hash set, stack, queue, deque, heap, trie, segment tree, Fenwick tree, binary search tree, adjacency list",
  },
  {
    id: "python",
    label: "Python",
    words: "heapq, deque, defaultdict, Counter, enumerate, bisect, itertools, lambda, list comprehension, __init__, self, None",
  },
  {
    id: "math",
    label: "Math",
    words: "Big O, logarithm, asymptotic, modulo, factorial, permutation, combination, recurrence, induction, matrix, vector, eigenvalue",
  },
];

/** The preset whose words match the field exactly, or "custom"/"none". */
export function vocabularyPresetId(vocabulary: string): string {
  const text = vocabulary.trim();
  if (!text) return "none";
  return VOCABULARY_PRESETS.find(preset => preset.words === text)?.id ?? "custom";
}
