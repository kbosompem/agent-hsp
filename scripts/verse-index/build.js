const fs = require("fs");
const path = require("path");

async function main() {
  const { pipeline, env } = require("@huggingface/transformers");
  env.allowLocalModels = false;

  const kjv = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../desktop/crates/preso-core/kjv.json"), "utf8")
  );
  const books = kjv.books;

  const refs = [];
  const labels = [];
  const texts = [];
  const model = "Xenova/all-MiniLM-L6-v2";
  console.log("loading", model, "…");
  const embedder = await pipeline("feature-extraction", model, { dtype: "q8" });

  for (let b = 0; b < books.length; b++) {
    const chapters = books[b].c;
    for (let c = 0; c < chapters.length; c++) {
      for (let v = 0; v < chapters[c].length; v++) {
        refs.push([b, c + 1, v + 1]);
        const bookName = books[b].n === "Psalms" ? "Psalm" : books[b].n;
        labels.push(bookName + " " + (c + 1) + ":" + (v + 1));
        texts.push(chapters[c][v]);
      }
    }
  }
  console.log("verses to embed:", refs.length);

  const out = new Float32Array(refs.length * 384);
  const BATCH = 64;
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await embedder(batch, { pooling: "mean", normalize: true });
    for (let j = 0; j < batch.length; j++) {
      out.set(res.data.slice(j * 384, (j + 1) * 384), (i + j) * 384);
    }
    done += batch.length;
    if (done % 3200 === 0 || done === texts.length) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(done + " / " + texts.length + " (" + mins + " min)");
    }
  }

  const binPath = path.join(__dirname, "../../desktop/public/verse-index.bin");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, Buffer.from(out.buffer));
  const metaPath = path.join(__dirname, "../../desktop/public/verse-index.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ dim: 384, count: refs.length, refs: refs, labels: labels })
  );
  console.log("written:", binPath, "(" + Math.round(fs.statSync(binPath).size / 1048576) + " MB)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
