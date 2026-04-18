const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const entryFile = path.join(projectRoot, "src", "webview", "diffViewApp.tsx");
const outDir = path.join(projectRoot, "media");
const outfile = path.join(outDir, "diffView.js");

fs.mkdirSync(outDir, { recursive: true });

esbuild
  .build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    minify: false,
    sourcemap: false,
    platform: "browser",
    format: "iife",
    target: ["es2020"],
    jsx: "automatic",
    loader: {
      ".ts": "ts",
      ".tsx": "tsx"
    },
    define: {
      "process.env.NODE_ENV": "\"production\""
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
