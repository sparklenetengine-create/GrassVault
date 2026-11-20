import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceRoot = resolve(projectRoot, "src");
const outputDirectory = resolve(projectRoot, "dist");

function copyManifest() {
  return {
    name: "copy-extension-manifest",
    apply: "build",
    async closeBundle() {
      await mkdir(outputDirectory, { recursive: true });
      await copyFile(resolve(sourceRoot, "manifest.json"), resolve(outputDirectory, "manifest.json"));
    }
  };
}

export default defineConfig({
  root: sourceRoot,
  publicDir: false,
  plugins: [copyManifest()],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(sourceRoot, "background/service-worker.js"),
        "content/contentScript": resolve(sourceRoot, "content/contentScript.js"),
        "popup/popup": resolve(sourceRoot, "popup/popup.html"),
        "dashboard/index": resolve(sourceRoot, "dashboard/index.html")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
