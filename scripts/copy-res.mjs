import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = "src";
const OUT = "dist/src";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      yield* walk(file);
    } else {
      yield file;
    }
  }
}

mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const file of walk(SRC)) {
  if (!file.endsWith(".res.mjs")) continue;
  const dest = join(OUT, relative(SRC, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest, { force: true });
  copied++;
}
console.log(`copy-res: ${copied} file(s) copied to ${OUT}`);
