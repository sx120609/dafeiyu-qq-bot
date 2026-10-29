// Generate 大肥鱼 sticker images with the local Codex CLI image model, one `codex exec` per image, at most 3 at a time.
// Usage: node gen.mjs <id>[@variant] ...      e.g. node gen.mjs 03   or   node gen.mjs 01 02 04@r2
// Work dirs: stickers/work/<id>-<slug>[-variant]/ (out.png, prompt.txt, run.log, last.txt).
// References come from stickers/work/picks.json (id -> chosen work folder) for the anchors;
// extra per-sticker prompt text for retries goes in stickers/work/notes.json (id -> text).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tools = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(tools, "..");
const workRoot = path.join(root, "work");
const project = path.resolve(root, "..");
const logo = path.join(project, "upstream", "Resources", "QQControl", "logo.png");
const codex = path.join(project, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
const catalog = JSON.parse(readFileSync(path.join(tools, "catalog.json"), "utf8"));
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const picks = readJson(path.join(workRoot, "picks.json"));
const notes = readJson(path.join(workRoot, "notes.json"));
// Never more than 3 Codex runs at once across all gen.mjs processes; STICKER_LIMIT lowers this one's share.
const LIMIT = Math.min(3, Number(process.env.STICKER_LIMIT) || 3);

function pickedImage(id) {
  const folder = picks[id];
  if (!folder) throw new Error(`no pick recorded for anchor ${id} in work/picks.json`);
  const file = path.join(workRoot, folder, "out.png");
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return file;
}

function references(sticker) {
  const character = catalog.characters[sticker.who];
  const isAnchor = character.anchor === sticker.id;
  if (sticker.who === "dfy") {
    if (isAnchor) {
      return {
        files: [logo],
        text: "Reference: the attached image is the official character art of 大肥鱼 (a head-and-shoulders portrait). Keep her design faithful to it: the same hair colour and blue gradient, the curled ahoge, the white frilly maid headband, the blue bows, the whale-fluke hair ornaments, the eye colour and the navy-and-white maid outfit with the navy bow and blue gem brooch. Unlike the portrait, draw her full body as a super-deformed chibi, about two and a half heads tall, with her whale tail visible.",
      };
    }
    return {
      files: [pickedImage(character.anchor), logo],
      text: "References: the first attached image is a finished sticker from this same sticker pack showing this same character. Match its art style exactly (line weight, soft cel shading, colours, the white die-cut sticker border, rendering quality) and its proportions (super-deformed chibi, about two and a half heads tall). The second attached image is her official character portrait; keep her design details faithful to it (hair, headband, bows, whale-fluke hair ornaments, eyes, outfit). Only the pose, expression and props change.",
    };
  }
  if (isAnchor) {
    return {
      files: [pickedImage(catalog.characters.dfy.anchor)],
      text: "Reference: the attached image is a finished sticker from this same sticker pack, but it shows a DIFFERENT character. Match its art style exactly (line weight, soft cel shading, colour richness, the white die-cut sticker border, the chibi proportions and rendering quality), but do NOT copy that character: the new character has no blue hair, no maid outfit, no maid headband, no whale tail and no whale features of any kind.",
    };
  }
  return {
    files: [pickedImage(character.anchor)],
    text: "Reference: the attached image is a finished sticker of this same character from this same sticker pack. Keep her design exactly the same (hair style and colour, face, eyes, hair ornament, glasses if any, outfit and colours) and match its art style and proportions (super-deformed chibi, about two and a half heads tall). Only the pose, expression and props change.",
  };
}

function buildPrompt(sticker, refText) {
  const character = catalog.characters[sticker.who];
  const symbols = sticker.allowQuestionMark
    ? "any text, letters, numbers, words, captions, speech bubbles, signatures or watermarks (the single floating question-mark shape described above is the only allowed symbol)"
    : "any text, letters, numbers, words, captions, speech bubbles, signatures or watermarks";
  const extra = notes[sticker.id] ? `\n\nImportant for this image: ${notes[sticker.id]}` : "";
  return `Use your built-in image generation tool (the image model) to create ONE image, then make sure the resulting PNG file exists at ./out.png in the current working directory (copy it there if the tool saved it elsewhere). Do NOT draw it with code, SVG, PIL or canvas. When done, reply with just the path.

What: one sticker for a chat sticker pack, square 1:1.

Art style: cute, high-quality anime chibi sticker illustration, polished and professional like an official character sticker set. Clean, confident, smooth lineart; soft cel shading with gentle highlights; bright, clear, harmonious colours; a very expressive face and lively body language. Not low-effort, not a meme template, not cringe, not a 3D render, not pixel art, not flat clip-art.

Character: ${character.text}

Proportions: super-deformed chibi, about two and a half heads tall: a big head, a small soft body, short arms and legs, small hands drawn cleanly with the right number of fingers (or simplified mitten-like hands), no extra arms, legs or fingers.

Pose and expression: ${sticker.pose}

${refText}

Sticker look: a clean, thick, even white die-cut sticker border runs around the outside of the whole figure (and around any small prop or effect that floats beside her), like a printed vinyl sticker.

Composition: exactly one character, centred, the whole figure visible and nothing cropped, filling about 80% of the square with a clear margin on every side.

Background: ONE perfectly flat, uniform pure magenta colour (#FF00FF) over the entire square, edge to edge, with no gradient, no shadow, no glow, no floor and no scenery. It is a chroma key that will be removed. Do not use magenta or hot pink anywhere on the character, props or effects (a soft pale blush on the cheeks is fine).

The image must not contain ${symbols}; nothing that resembles a national flag or a flag-like pattern; no political symbols; no real company logos or brand marks. Nothing suggestive: modest and fully clothed, no swimsuit, no fan-service. She is an adult drawn in a cute chibi style.${extra}`;
}

function runOne(spec) {
  const [id, variant] = spec.split("@");
  const sticker = catalog.stickers.find((item) => item.id === id);
  if (!sticker) throw new Error("unknown sticker " + id);
  const folder = `${id}-${sticker.slug}${variant ? "-" + variant : ""}`;
  const work = path.join(workRoot, folder);
  mkdirSync(work, { recursive: true });
  if (readdirSync(work).length) throw new Error(`work dir not empty: ${work}`);
  const refs = references(sticker);
  const prompt = buildPrompt(sticker, refs.text);
  const args = ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", work];
  for (const file of refs.files) args.push("-i", file);
  args.push("-o", path.join(work, "last.txt"), "-");
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(codex, args, { cwd: work, windowsHide: true });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    const timer = setTimeout(() => child.kill(), 900_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(path.join(work, "run.log"), log);
      writeFileSync(path.join(work, "prompt.txt"), prompt + "\n\n--- references ---\n" + refs.files.join("\n"));
      const result = { folder, status: code, seconds: Math.round((Date.now() - started) / 1000), out: existsSync(path.join(work, "out.png")) };
      console.log(JSON.stringify(result));
      resolve(result);
    });
    child.stdin.end(prompt);
  });
}

const queue = process.argv.slice(2);
if (!queue.length) throw new Error("usage: node gen.mjs <id>[@variant] ...");
const results = [];
async function worker() {
  while (queue.length) {
    const spec = queue.shift();
    try {
      results.push(await runOne(spec));
    } catch (error) {
      console.log(JSON.stringify({ spec, error: String(error.message || error) }));
    }
  }
}
await Promise.all(Array.from({ length: Math.min(LIMIT, queue.length) }, worker));
console.log("done", results.filter((item) => item.out).length, "/", results.length);
