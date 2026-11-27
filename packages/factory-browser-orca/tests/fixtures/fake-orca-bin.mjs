// A stand-in executable for spawnRunner tests. Behaviour is picked by argv[2].
const mode = process.argv[2];
if (mode === "hang") {
  setTimeout(() => {}, 60_000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(4 * 1024 * 1024));
} else if (mode === "stdin") {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ ok: true, result: { received: input, argv: process.argv.slice(3) } }));
  });
} else {
  process.stdout.write("not json");
}
