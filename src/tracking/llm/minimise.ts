// Data minimisation for the optional LLM, fail-closed. The model receives only words from a closed
// vocabulary of parcel-tracking wording, Czech dates and times, timeline colour markers and
// punctuation. Every other token (names, streets, towns, house and postal numbers, signatures,
// e-mail addresses, phone numbers, any word the vocabulary does not know) is replaced by "[…]", and a
// run of masked tokens becomes a single "[…]" so neither the length nor the number of masked words is
// passed on. A word missing from the vocabulary costs evidence (the answer stays UNKNOWN), never privacy.
//
// Residual risk: a name that is spelled exactly like a vocabulary word (e.g. a surname "Kurýr") is
// not recognised as a name. The vocabulary therefore holds only tracking wording and function words.

export const MASK = "[…]";
export const TRACKING_NUMBER = "[ČÍSLO ZÁSILKY]";
export const EMAIL = "[E-MAIL]";
export const PHONE = "[TELEFON]";

const PARTICIPLE = ["", "a", "o", "y", "i", "á", "é", "í", "ý", "ou", "ého", "ém", "ým", "ých", "ými"];
const PAST = ["", "a", "o", "i", "y"];
const withNe = (ws: string[]) => ws.flatMap((w) => [w, `ne${w}`]);
const forms = (stems: string[], endings: string[]) => stems.flatMap((s) => endings.map((e) => s + e));

const WORDS: string[] = [
  // status participles and past tenses, each also negated ("nedoručena", "nebyl", "nevrátil")
  ...withNe(forms(["doručen", "předán", "vyzvednut", "převzat", "vrácen", "uložen", "zpracován", "připraven", "odeslán",
    "podán", "zastižen", "nalezen", "ztracen", "poškozen", "odmítnut", "přijat", "zadržen", "přesměrován", "vyřízen",
    "doručován", "zaslán", "dodán", "naložen"], PARTICIPLE)),
  ...withNe(forms(["byl", "doručil", "předal", "vyzvedl", "převzal", "vrátil", "odmítl", "opustil", "uložil", "podepsal",
    "přijal", "dorazil", "našl", "podařil", "mohl", "dodal", "odeslal", "zastihl"], PAST)),
  ...withNe(["doručujeme", "doručíme", "doručí", "doručit", "doručovat", "vrací", "vracíme", "vracet", "vrátí", "vrátíme",
    "vrátit", "převzít", "vyzvednout", "vyzvedněte", "nakládáme", "zopakujeme", "pošleme", "informujeme", "informovat",
    "bude", "budeme", "budou", "je", "jsou", "jsme", "jste", "lze", "podařilo", "zobrazit", "změnit", "zadat", "vyjede",
    "uplynula", "uplynul", "končí", "skončila", "sledovat", "potřebujete", "máte", "má", "můžete", "mohou", "napište",
    "zkontrolujte", "zkuste", "jsem", "nejsem", "eviduje", "evidujeme", "čeká", "dorazí"]),
  "není", "nevíme",
  // nouns of the domain
  "zásilka", "zásilky", "zásilce", "zásilku", "zásilkou", "zásilek", "zásilkám", "zásilkách", "zásilkami",
  "balík", "balíku", "balíkem", "balíky", "balíků",
  "příjemce", "příjemci", "příjemcem", "příjemců", "odesílatel", "odesílatele", "odesílateli", "odesílatelem", "odesílatelů",
  "adresát", "adresáta", "adresátovi", "adresátem", "soused", "souseda", "sousedovi", "sousedem", "sousedka", "sousedky",
  "sousedce", "sousedku", "sousedkou", "kurýr", "kurýra", "kurýrovi", "kurýrem", "kurýři", "dopravce", "dopravci", "dopravcem",
  "doručení", "vyzvednutí", "převzetí", "podání", "vrácení", "uložení", "doručování", "odeslání",
  "depo", "depa", "depu", "depem", "box", "boxu", "boxem", "boxy", "centrum", "centra", "centru", "centrem",
  "pobočka", "pobočky", "pobočce", "pobočku", "pobočkou", "místo", "místa", "místě", "míst", "místem",
  "výdejní", "výdejním", "výdejního", "výdejnímu", "třídicí", "třídící", "třídicího", "třídicím", "třídírna", "třídírny", "třídírně",
  "přeprava", "přepravy", "přepravě", "přepravu", "přepravou", "cesta", "cesty", "cestě", "cestu", "cestou",
  "stav", "stavu", "událost", "události", "datum", "čas", "číslo", "čísla", "čísle", "číslem", "doba", "doby", "době", "dobu",
  "adresa", "adresy", "adrese", "adresu", "adresou", "důvod", "důvodu", "pokus", "pokusu", "pokusy", "podpis", "podpisem",
  "zpráva", "zprávy", "zprávou", "termín", "termínu", "den", "dne", "dny", "dnů", "dní", "hodin", "hodina", "hodiny",
  "objednávka", "objednávky", "osoba", "osobě", "osobou", "osoby", "osobu", "aktualizace", "aktualizováno", "průběh",
  "změna", "změnu", "změny", "dotaz", "sms", "e-mail", "e-mailem", "infolinka", "kroku", "krok", "zpožděním", "zpoždění",
  "sledování", "podáno", "doručeno", "vráceno", "zpracováno",
  // adjectives and adverbs
  "aktuální", "poslední", "úspěšně", "neúspěšně", "úspěšný", "neúspěšný", "úspěšné", "neúspěšné", "osobně", "třetí",
  "další", "předpokládaný", "předpokládaná", "předpokládané", "předpokládaného", "pracovní", "pracovních",
  "neznámý", "neznámá", "neznámé", "neznámou", "úložní", "úložné", "zpět", "zpátky", "právě", "později", "dříve", "online",
  "jakmile", "nejbližší", "uvedené", "uvedená", "uvedený", "uvedenou", "většinu", "doma",
  // function words
  "a", "i", "o", "s", "z", "ze", "u", "v", "ve", "k", "ke", "na", "do", "od", "po", "při", "pro", "před", "za", "se", "si",
  "nebo", "než", "až", "že", "pokud", "už", "ještě", "zatím", "zde", "tato", "tento", "toto", "to", "tímto", "tím", "tuto",
  "tohoto", "této", "která", "který", "které", "kde", "kdy", "co", "když", "jak", "moje", "moji", "mou", "vaše", "váš",
  "vaši", "vás", "vám", "vy", "my", "nám", "nás", "prosím", "kdo",
];
const VOCABULARY: ReadonlySet<string> = new Set(WORDS);
/**
 * Negations that are not "ne" + another vocabulary word. "neznámý" (unknown addressee) is not here:
 * it gives the reason for a return, it does not negate one.
 */
const NEGATIVE: ReadonlySet<string> = new Set(["není", "nevíme"]);

/**
 * True for a negated vocabulary word. Structural, not a list of phrases: every visible word of the
 * model input is in the closed vocabulary, so "ne" + a vocabulary word ("nebyla", "nepodařilo",
 * "nemohla", "nevracíme", "nebude") is a negation, while "nebo", "než", "nejbližší" are not.
 */
export function isNegated(word: string): boolean {
  const w = word.toLowerCase();
  return NEGATIVE.has(w) || (w.startsWith("ne") && VOCABULARY.has(w.slice(2)));
}

// Tokens in priority order; every non-space character is consumed by exactly one alternative.
const TOKEN = new RegExp([
  /\[ČÍSLO ZÁSILKY\]|\[E-MAIL\]|\[TELEFON\]/.source,
  /\[barva kroku: #[0-9a-f]{3,8}\]/.source,
  /(?<!\d)\d{1,2}\.\s?\d{1,2}\.\s?\d{4}(?!\d)/.source, // date
  /(?<!\d)\d{1,2}:\d{2}(?!\d)/.source, // time
  /[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/u.source, // word
  /[.,:;!?()"'„“”–—\-/]/.source, // punctuation (single character)
  /\S/.source, // anything else
].join("|"), "giu");
const PUNCTUATION = /^[.,:;!?()"'„“”–—\-/]$/u;

/** Masks every token that is not tracking vocabulary, a date, a time, a marker or punctuation. */
export function minimise(text: string): string {
  return text
    .replace(TOKEN, (tok: string, offset: number, all: string) => {
      if (/^[\p{L}\p{M}]/u.test(tok)) {
        const initial = tok.length === 1 && tok !== tok.toLowerCase() && all[offset + 1] === ".";
        return !initial && VOCABULARY.has(tok.toLowerCase()) ? tok : MASK;
      }
      // Multi-character non-words are the placeholders, markers, dates and times matched above.
      return tok.length > 1 || PUNCTUATION.test(tok) ? tok : MASK;
    })
    .replace(/\[…\](?:\s*\[…\])+/gu, MASK)
    .replace(/\s+/g, " ")
    .trim();
}
