import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
    globalIgnores(["**/.turbo/**", "**/dist/**", "**/coverage/**", ".idea/**"]),
    js.configs.recommended,
]);
