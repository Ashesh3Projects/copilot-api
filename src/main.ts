#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import packageJson from "../package.json" with { type: "json" }
import { admin } from "./admin"
import { auth } from "./auth"
import { checkUsage } from "./check-usage"
import { config } from "./config"
import { debug } from "./debug"
import { start } from "./start"
import { storage } from "./storage"

const main = defineCommand({
  meta: {
    name: "copilot-api",
    version: packageJson.version,
    description:
      "A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.",
  },
  subCommands: {
    admin,
    auth,
    start,
    storage,
    "check-usage": checkUsage,
    debug,
    config,
  },
})

await runMain(main)
