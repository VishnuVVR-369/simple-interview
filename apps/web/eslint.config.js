import { nextJsConfig } from "@repo/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    // Node config files run on the server and may read process.env.
    files: ["next.config.js"],
    languageOptions: {
      globals: { process: "readonly" },
    },
  },
];
