import { build } from "esbuild";

await build({
  entryPoints: ["src/worker/main.ts"],
  outfile: "dist/railway-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  tsconfig: "tsconfig.json",
  logLevel: "info",
  plugins: [{
    // This build target is a Node-only process. Retain Next's server-only
    // import guard in all web builds; resolve it only for this worker bundle.
    name: "worker-server-only",
    setup(builder) {
      builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "worker-node-only" }));
      builder.onLoad({ filter: /.*/, namespace: "worker-node-only" }, () => ({ contents: "", loader: "js" }));
    },
  }],
});
