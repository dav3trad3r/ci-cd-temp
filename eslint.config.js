import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // .claude/skills/ holds third-party agent skills, kept close to the originals so they are easy to update.
  { ignores: ["dist/", "coverage/", "node_modules/", ".claude/skills/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
]);
