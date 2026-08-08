import { loadWordsFromCsv } from './csvLoader.js';

let words = [];
let byKey = new Map();

/** Reads data/teps_words.csv fresh (via main process) and rebuilds the in-memory store. */
export async function loadWords() {
  const csvText = await window.excelvoca.loadWords();
  words = loadWordsFromCsv(csvText);
  byKey = new Map(words.map((w) => [w.key, w]));
  return words;
}

export function getAllWords() {
  return words;
}

/** Looks up a specific sense by its `key` (word+pos+meaning) — a word can have several. */
export function getWordByKey(key) {
  return byKey.get(key);
}

/** "word (pos)" for display — phrases (pos "phr") skip the suffix since they're long enough already. */
export function formatDisplay(wordObj) {
  return wordObj.pos && wordObj.pos !== 'phr' ? `${wordObj.word} (${wordObj.pos})` : wordObj.word;
}

/**
 * Fills `result` (up to `count`, deduped by whatever `keyFor` returns) from
 * `pool` in random order. Used to prefer a same-pos pool first and only spill
 * into a wider fallback pool if that pos doesn't have enough distinct items.
 */
function fillRandom(pool, count, keyFor, seen, result) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const w of shuffled) {
    if (result.length >= count) break;
    const k = keyFor(w);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(w);
  }
}

/**
 * Returns `count` random {meaning, word} pairs from words other than
 * `excludeWord`, with no duplicate meanings. Distractors are drawn from
 * words sharing `pos` with the correct answer first (falling back to any pos
 * only if that's not enough to fill `count`) — otherwise a Korean meaning's
 * own grammatical ending (품사) can give away which choice is correct
 * without knowing the word at all, since the choices would visibly mix
 * noun/verb/adjective forms. The `word` each meaning came from rides along
 * so the UI can reveal "that's actually X's meaning" when a distractor is
 * picked by mistake.
 *
 * `excludeMeaning` (normally the correct answer's own meaning text) is also
 * seeded into `seen` up front, so a near-synonym pair that happens to share
 * the exact same Korean gloss (e.g. abandon/renounce both "포기하다/버리다")
 * never gets drawn as a distractor — that would otherwise put the same
 * choice text on screen twice, once as the correct answer and once as a
 * decoy, with no way to tell them apart.
 */
export function getRandomOtherMeanings(excludeWord, count, pos, excludeMeaning) {
  const basePool = words.filter((w) => w.word !== excludeWord);
  const seen = new Set(excludeMeaning ? [excludeMeaning] : []);
  const result = [];
  if (pos) fillRandom(basePool.filter((w) => w.pos === pos), count, (w) => w.meaning, seen, result);
  fillRandom(basePool, count, (w) => w.meaning, seen, result);
  return result.map((w) => ({ meaning: w.meaning, word: w.word }));
}

/**
 * Reverse-mode distractors: `count` random {display, meaning} pairs (e.g.
 * "grave (n)" paired with its own Korean meaning), no duplicate display
 * text. Same same-pos-first preference as `getRandomOtherMeanings` and for
 * the same reason — here the pos suffix is shown directly on every choice,
 * so mixed pos would leak the answer even more directly. `excludeDisplay`
 * (the correct answer's own display text) is seeded into `seen` defensively,
 * mirroring `getRandomOtherMeanings`. The `meaning` rides along so the UI
 * can reveal what a wrongly-picked word actually means.
 */
export function getRandomOtherWordDisplays(excludeWord, count, pos, excludeDisplay) {
  const basePool = words.filter((w) => w.word !== excludeWord);
  const seen = new Set(excludeDisplay ? [excludeDisplay] : []);
  const result = [];
  if (pos) fillRandom(basePool.filter((w) => w.pos === pos), count, formatDisplay, seen, result);
  fillRandom(basePool, count, formatDisplay, seen, result);
  return result.map((w) => ({ display: formatDisplay(w), meaning: w.meaning }));
}

export function filterByLevel(level) {
  return words.filter((w) => w.level === level);
}

export function filterByPos(pos) {
  return words.filter((w) => w.pos === pos);
}

/**
 * Other registered senses of the same word (e.g. "address" (n) 주소 also
 * has "address" (v) 다루다/처리하다), excluding the sense identified by
 * `excludeKey`. Used to surface "이 단어는 이런 뜻도 있어요" on answer
 * reveal so a polysemous word's other pos/meaning isn't a total surprise
 * the next time it comes up as a different quiz item.
 */
export function getOtherSenses(word, excludeKey) {
  return words
    .filter((w) => w.word === word && w.key !== excludeKey)
    .map((w) => ({ pos: w.pos, meaning: w.meaning }));
}

export function searchWords(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return words.filter(
    (w) => w.word.toLowerCase().includes(q) || w.meaning.includes(q)
  );
}
