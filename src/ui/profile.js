// The hunter's identity lives in this browser only: a random key, a name and a sigil. No login.

const KEY = "wb-profile-v1";
const NAMES_A = ["Ash", "Brand", "Cinder", "Wren", "Moss", "Thorn", "Vesper", "Rook", "Sable", "Hale", "Lark", "Quill", "Ember", "Fen", "Gale", "Iris"];
const NAMES_B = ["of the Margin", "the Patient", "of Nine Bells", "the Unlettered", "of the Lantern Road", "the Small", "of Salt", "the Late", "of the Psalter", "the Wary"];

function randomKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function suggestName() {
  const a = NAMES_A[Math.floor(Math.random() * NAMES_A.length)];
  const b = NAMES_B[Math.floor(Math.random() * NAMES_B.length)];
  return (a + " " + b).slice(0, 18);
}

export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "null");
    if (p && p.key && p.name) return { aspect: "ember", sigil: 0, best: 0, runs: 0, total: 0, ...p };
  } catch {}
  const p = { key: randomKey(), name: suggestName().slice(0, 18), sigil: Math.floor(Math.random() * 16), aspect: "ember", best: 0, runs: 0, total: 0, fresh: true };
  saveProfile(p);
  return p;
}

export function saveProfile(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

export function cleanName(s) {
  return (s || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>{}[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
}
