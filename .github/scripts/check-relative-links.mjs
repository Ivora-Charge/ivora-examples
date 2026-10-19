// Checks that relative links in the root Markdown files point to files or
// folders that exist. External links (http, https, mailto) are not fetched.
// Usage: node .github/scripts/check-relative-links.mjs [file ...]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function markdownFiles(dir, recurse) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return recurse ? markdownFiles(path, true) : [];
    return name.endsWith(".md") ? [path] : [];
  });
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((file) => resolve(file))
  : [
      ...markdownFiles(root, false),
      ...markdownFiles(join(root, "docs"), true),
      ...markdownFiles(join(root, ".github"), true),
    ];

// Inline links and images: [text](target "title") and reference definitions: [id]: target
const inline = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const reference = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm;

function headingAnchors(path) {
  const anchors = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    anchors.add(
      match[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-"),
    );
  }
  return anchors;
}

let failures = 0;
for (const file of files) {
  // Ignore links inside fenced code blocks and inline code.
  const text = readFileSync(file, "utf8")
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const targets = [...text.matchAll(inline), ...text.matchAll(reference)].map(
    (m) => m[1],
  );
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
      continue;
    const [pathPart, anchor] = target.split("#");
    const destination = pathPart
      ? resolve(dirname(file), decodeURIComponent(pathPart))
      : file;
    let problem = null;
    if (!destination.startsWith(root))
      problem = "points outside the repository";
    else if (!existsSync(destination)) problem = "does not exist";
    else if (
      anchor &&
      destination.endsWith(".md") &&
      !headingAnchors(destination).has(anchor)
    )
      problem = `has no heading for #${anchor}`;
    if (problem) {
      failures += 1;
      console.error(`${relative(root, file)}: link "${target}" ${problem}`);
    }
  }
}

if (failures) {
  console.error(`${failures} broken relative link(s).`);
  process.exit(1);
}
console.log(`Relative links OK in ${files.length} file(s).`);
