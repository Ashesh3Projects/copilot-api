import config from "@echristian/eslint-config"

export default config(
  {
    ignores: [
      "src/routes/dashboard/page-generated.ts",
      "ui/dist",
      "ui/scripts",
    ],
    react: {
      enabled: true,
    },
    reactHooks: {
      enabled: true,
    },
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  },
  {
    rules: {
      "prettier/prettier": [
        "error",
        {
          endOfLine: "auto",
          semi: false,
          experimentalOperatorPosition: "start",
          experimentalTernaries: true,
        },
      ],
    },
  },
  {
    // React screen components legitimately exceed the server-code size caps
    files: ["ui/**/*.tsx"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Server code: no React here; rules-of-hooks false-positives on
    // functions like useFunctionApplyPatch
    files: ["src/**", "tests/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    // Flat aggregation of dashboard API route handlers; grows one function per
    // feature, so the default 800-line cap is not a useful signal here.
    files: ["src/routes/dashboard/api.ts"],
    rules: {
      "max-lines": ["error", 1200],
    },
  },
  {
    // Sentry owns the complete ordinary-telemetry privacy boundary, including
    // all send hooks and hostile nested header encodings.
    files: ["src/lib/sentry.ts"],
    rules: {
      "max-lines": ["error", 1100],
    },
  },
  {
    // The administrator security suite intentionally keeps the complete auth
    // boundary, failure accounting, and session lifecycle in one test file.
    files: ["tests/admin-auth.test.ts"],
    rules: {
      "max-lines": ["error", 1000],
    },
  },
)
